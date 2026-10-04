#!/usr/bin/env python3
"""Build an installable Android APK that wraps the web app in a WebView.

Needs only a JDK (javac, jarsigner, keytool) and Python 3. The other tools
come from Maven Central, since Google's Android SDK servers aren't needed:
  - dx (dex compiler):  com.jakewharton.android.repackaged:dalvik-dx
  - Android API jar:    org.robolectric:android-all (compile classpath only)
The binary AndroidManifest.xml and resources.arsc are written by this script.

Usage:  python3 android/build_apk.py [--keystore PATH] [--out PATH]
"""
import argparse
import os
import shutil
import struct
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, "android")
MAVEN = "https://repo1.maven.org/maven2"
TOOLS = {
    "dx.jar": f"{MAVEN}/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar",
    "android-all.jar": f"{MAVEN}/org/robolectric/android-all/10-robolectric-5803371/android-all-10-robolectric-5803371.jar",
}

PACKAGE = "com.numberaxis.app"
LABEL = "ציר המספרים"
VERSION_CODE = 4
VERSION_NAME = "1.3"
MIN_SDK = 21
TARGET_SDK = 29  # v1 (JAR) signing is accepted for targetSdk < 30

WEB_FILES = ["index.html", "style.css", "fonts.css", "app.js", "icon.svg", "manifest.webmanifest"]

# android.R.attr ids
ATTR = {
    "theme": 0x01010000, "label": 0x01010001, "icon": 0x01010002, "name": 0x01010003,
    "exported": 0x01010010, "screenOrientation": 0x0101001E, "configChanges": 0x0101001F,
    "launchMode": 0x0101001D, "minSdkVersion": 0x0101020C, "versionCode": 0x0101021B,
    "versionName": 0x0101021C, "targetSdkVersion": 0x01010270, "hardwareAccelerated": 0x010102D3,
}
THEME_FULLSCREEN = 0x0103012D  # Theme.DeviceDefault.Light.NoActionBar.Fullscreen
ICON_RES_ID = 0x7F010000  # @drawable/icon, defined in our resources.arsc
ANDROID_NS = "http://schemas.android.com/apk/res/android"

T_REF, T_STRING, T_INT_DEC, T_INT_HEX, T_BOOL = 0x01, 0x03, 0x10, 0x11, 0x12


# ---------------------------------------------------------------- binary XML
def string_pool(strings):
    """ResStringPool chunk, UTF-16 encoded."""
    offsets, data = [], b""
    for s in strings:
        offsets.append(len(data))
        u = s.encode("utf-16-le")
        data += struct.pack("<H", len(u) // 2) + u + b"\x00\x00"
    data += b"\x00" * (-len(data) % 4)
    header_size = 28
    strings_start = header_size + 4 * len(strings)
    size = strings_start + len(data)
    return (struct.pack("<HHIIIIII", 0x0001, header_size, size, len(strings), 0, 0, strings_start, 0)
            + b"".join(struct.pack("<I", o) for o in offsets) + data)


def manifest_xml():
    # (tag, [(attr, type, value)], children). Android attrs are in the android namespace.
    tree = ("manifest", [("package", T_STRING, PACKAGE),
                         ("versionCode", T_INT_DEC, VERSION_CODE),
                         ("versionName", T_STRING, VERSION_NAME)], [
        ("uses-sdk", [("minSdkVersion", T_INT_DEC, MIN_SDK),
                      ("targetSdkVersion", T_INT_DEC, TARGET_SDK)], []),
        ("application", [("theme", T_REF, THEME_FULLSCREEN),
                         ("label", T_STRING, LABEL),
                         ("icon", T_REF, ICON_RES_ID),
                         ("hardwareAccelerated", T_BOOL, True)], [
            ("activity", [("name", T_STRING, PACKAGE + ".MainActivity"),
                          ("exported", T_BOOL, True),
                          ("launchMode", T_INT_DEC, 2),  # singleTask
                          ("screenOrientation", T_INT_DEC, 6),  # sensorLandscape
                          ("configChanges", T_INT_HEX, 0x04A0)], [  # orientation|screenSize|keyboardHidden
                ("intent-filter", [], [
                    ("action", [("name", T_STRING, "android.intent.action.MAIN")], []),
                    ("category", [("name", T_STRING, "android.intent.category.LAUNCHER")], []),
                ]),
            ]),
        ]),
    ])

    # Attribute names with resource ids must come first in the pool, matching the resource map.
    res_names = list(ATTR)
    strings = list(res_names)

    def idx(s):
        if s not in strings:
            strings.append(s)
        return strings.index(s)

    for s in ("android", ANDROID_NS):
        idx(s)

    def walk(node):
        tag, attrs, kids = node
        idx(tag)
        for name, typ, val in attrs:
            idx(name)
            if typ == T_STRING:
                idx(val)
        for k in kids:
            walk(k)
    walk(tree)

    ns_uri = idx(ANDROID_NS)
    body = b""

    def node_bytes(node, line=1):
        tag, attrs, kids = node
        enc = []
        for name, typ, val in attrs:
            ns = 0xFFFFFFFF if name == "package" else ns_uri
            if typ == T_STRING:
                raw, data = idx(val), idx(val)
            elif typ == T_BOOL:
                raw, data = 0xFFFFFFFF, 0xFFFFFFFF if val else 0
            else:
                raw, data = 0xFFFFFFFF, val
            enc.append((ATTR.get(name, 0xFFFFFFFF), struct.pack("<IIIHBBI", ns, idx(name), raw, 8, 0, typ, data)))
        enc.sort(key=lambda a: a[0])  # aapt orders attributes by resource id
        attr_data = b"".join(a[1] for a in enc)
        ext = struct.pack("<IIHHHHHH", 0xFFFFFFFF, idx(tag), 20, 20, len(enc), 0, 0, 0)
        start = struct.pack("<HHIII", 0x0102, 16, 16 + len(ext) + len(attr_data), line, 0xFFFFFFFF) + ext + attr_data
        out = start
        for k in kids:
            out += node_bytes(k, line + 1)
        out += struct.pack("<HHIIIII", 0x0103, 16, 24, line, 0xFFFFFFFF, 0xFFFFFFFF, idx(tag))
        return out

    body = node_bytes(tree)
    ns_start = struct.pack("<HHIIIII", 0x0100, 16, 24, 1, 0xFFFFFFFF, idx("android"), ns_uri)
    ns_end = struct.pack("<HHIIIII", 0x0101, 16, 24, 1, 0xFFFFFFFF, idx("android"), ns_uri)
    pool = string_pool(strings)
    res_map = struct.pack("<HHI", 0x0180, 8, 8 + 4 * len(res_names)) + b"".join(
        struct.pack("<I", ATTR[n]) for n in res_names)
    content = pool + res_map + ns_start + body + ns_end
    return struct.pack("<HHI", 0x0003, 8, 8 + len(content)) + content


# --------------------------------------------------------- resources.arsc
def resources_arsc():
    """A resource table with a single entry: @drawable/icon -> res/drawable-xxxhdpi-v4/icon.png."""
    values = string_pool(["res/drawable-xxxhdpi-v4/icon.png"])
    type_strings = string_pool(["drawable"])
    key_strings = string_pool(["icon"])

    type_spec = struct.pack("<HHIBBHI", 0x0202, 16, 16 + 4, 1, 0, 0, 1) + struct.pack("<I", 0)

    config = bytearray(64)
    struct.pack_into("<I", config, 0, 64)
    struct.pack_into("<H", config, 14, 640)  # density: xxxhdpi
    struct.pack_into("<H", config, 24, 4)  # sdkVersion: v4 (implied by density qualifier)
    entry = struct.pack("<HHI", 8, 0, 0) + struct.pack("<HBBI", 8, 0, T_STRING, 0)
    header_size = 20 + 64
    entries_start = header_size + 4
    type_chunk = (struct.pack("<HHIBBHII", 0x0201, header_size, entries_start + len(entry), 1, 0, 0, 1, entries_start)
                  + bytes(config) + struct.pack("<I", 0) + entry)

    name = "com.numberaxis.app".encode("utf-16-le").ljust(256, b"\x00")
    pkg_header_size = 288
    type_off = pkg_header_size
    key_off = type_off + len(type_strings)
    pkg_body = type_strings + key_strings + type_spec + type_chunk
    package = struct.pack("<HHII", 0x0200, pkg_header_size, pkg_header_size + len(pkg_body), 0x7F) + name + \
        struct.pack("<IIIII", type_off, 1, key_off, 1, 0) + pkg_body

    content = values + package
    return struct.pack("<HHII", 0x0002, 12, 12 + len(content), 1) + content


# ------------------------------------------------------------------- build
def tool(name, cache):
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        print(f"downloading {name} ...")
        urllib.request.urlretrieve(TOOLS[name], path + ".part")
        os.replace(path + ".part", path)
    return path


def run(*cmd):
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "number-axis.apk"))
    ap.add_argument("--keystore", default=os.path.join(HERE, ".build-cache", "release.keystore"))
    ap.add_argument("--storepass", default=os.environ.get("APK_STOREPASS", "numberaxis"))
    args = ap.parse_args()

    cache = os.path.join(HERE, ".build-cache")
    os.makedirs(cache, exist_ok=True)
    dx, android_jar = tool("dx.jar", cache), tool("android-all.jar", cache)

    with tempfile.TemporaryDirectory() as tmp:
        classes = os.path.join(tmp, "classes")
        os.makedirs(classes)
        sources = [os.path.join(dp, f) for dp, _, fs in os.walk(os.path.join(HERE, "src")) for f in fs if f.endswith(".java")]
        run("javac", "-nowarn", "--release", "8", "-cp", android_jar, "-d", classes, *sources)
        dex = os.path.join(tmp, "classes.dex")
        run("java", "-cp", dx, "com.android.dx.command.Main", "--dex", f"--min-sdk-version={MIN_SDK}", f"--output={dex}", classes)

        unsigned = os.path.join(tmp, "unsigned.apk")
        with zipfile.ZipFile(unsigned, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("AndroidManifest.xml", manifest_xml())
            z.writestr(zipfile.ZipInfo("resources.arsc"), resources_arsc(), compress_type=zipfile.ZIP_STORED)
            z.write(dex, "classes.dex")
            z.write(os.path.join(HERE, "icon.png"), "res/drawable-xxxhdpi-v4/icon.png", compress_type=zipfile.ZIP_STORED)
            for f in WEB_FILES:
                z.write(os.path.join(ROOT, f), "assets/" + f)
            for f in sorted(os.listdir(os.path.join(ROOT, "fonts"))):
                z.write(os.path.join(ROOT, "fonts", f), "assets/fonts/" + f, compress_type=zipfile.ZIP_STORED)

        if not os.path.exists(args.keystore):
            run("keytool", "-genkeypair", "-keystore", args.keystore, "-alias", "numberaxis",
                "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
                "-storepass", args.storepass, "-keypass", args.storepass,
                "-dname", "CN=Number Axis")
        run("jarsigner", "-sigalg", "SHA256withRSA", "-digestalg", "SHA-256",
            "-keystore", args.keystore, "-storepass", args.storepass, unsigned, "numberaxis")

        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        shutil.copy(unsigned, args.out)
    print(f"APK ready: {args.out} ({os.path.getsize(args.out) // 1024} KB)")


if __name__ == "__main__":
    main()
