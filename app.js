(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFAULT_RANGE = { from: 1, to: 20 };
  const PRESETS = [
    { from: 1, to: 10 },
    { from: 1, to: 20 },
    { from: 0, to: 20 },
    { from: 1, to: 30 },
    { from: 1, to: 50 },
    { from: 1, to: 100 },
    { from: -10, to: 10 },
    { from: -20, to: 20 },
  ];
  const MAX_SPAN = 200;
  const SIDE_PAD = 24; // room for the arrow heads at both ends
  // Axes up to this many numbers fit on one screen (1–20, 0–20, −10–10). Longer ones scroll
  // sideways and keep the same number size as a 20-number axis.
  const FIT_COUNT = 21;
  const MIN_FONT = 15; // below this, long axes label only every 2nd/5th/10th number

  const $ = (id) => document.getElementById(id);
  const svg = $("axis");
  const wrap = $("axisWrap");
  const messageEl = $("message");

  const storage = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  const state = {
    range: validRange(storage.get("range", DEFAULT_RANGE)) || { ...DEFAULT_RANGE },
    seq: [], // counted numbers, in order
    dir: 0, // +1 counting up, -1 counting down, 0 not decided yet
    sound: storage.get("sound", true),
  };

  function validRange(r) {
    if (!r || !Number.isInteger(r.from) || !Number.isInteger(r.to)) return null;
    if (r.to <= r.from || r.to - r.from > MAX_SPAN) return null;
    return { from: r.from, to: r.to };
  }

  /* ---------- Colors: a soft rainbow along the axis ---------- */
  function hueFor(n) {
    const { from, to } = state.range;
    const t = (n - from) / Math.max(1, to - from);
    return Math.round(t * 300); // red → orange → green → blue → purple
  }
  const textColor = (n) => `hsl(${hueFor(n)} 62% 44%)`;
  const softColor = (n) => `hsl(${hueFor(n)} 85% 90%)`;
  const lineColor = (n) => `hsl(${hueFor(n)} 65% 58%)`;

  /* ---------- Sound (Web Audio, no files needed) ---------- */
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function tone(freq, start, duration, type = "sine", volume = 0.18) {
    const ac = ctx();
    if (!ac) return;
    const t0 = ac.currentTime + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  // Major pentatonic notes, so consecutive clicks always sound pleasant.
  const PENTA = [0, 2, 4, 7, 9];
  function playCount(step) {
    if (!state.sound) return;
    const semis = PENTA[step % 5] + 12 * (Math.floor(step / 5) % 2); // stay within two octaves
    const f = 523.25 * Math.pow(2, semis / 12); // from C5
    tone(f, 0, 0.35, "sine", 0.2);
    tone(f * 2, 0, 0.18, "triangle", 0.04); // a little sparkle
  }
  function playError() {
    if (!state.sound) return;
    tone(392, 0, 0.18, "triangle", 0.14);
    tone(311.13, 0.14, 0.28, "triangle", 0.14);
  }
  function playClear() {
    if (!state.sound) return;
    [784, 659.25, 523.25].forEach((f, i) => tone(f, i * 0.07, 0.2, "sine", 0.12));
  }

  /* ---------- Keep the screen on (Screen Wake Lock API) ---------- */
  let wakeLock = null;
  async function requestWakeLock() {
    // Inside the Android app the native shell keeps the screen on.
    if (window.AndroidApp) {
      setWakeStatus(true);
      return;
    }
    if (!("wakeLock" in navigator)) {
      setWakeStatus(false, "הדפדפן לא תומך בהשארת המסך דלוק");
      return;
    }
    if (wakeLock || document.visibilityState !== "visible") return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      setWakeStatus(true);
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
        setWakeStatus(false, "המסך עלול לכבות");
      });
    } catch {
      setWakeStatus(false, "המסך עלול לכבות");
    }
  }
  function setWakeStatus(on, text) {
    $("wakeStatus").classList.toggle("off", !on);
    $("wakeText").textContent = on ? "המסך יישאר דלוק" : text;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });
  // Some browsers only grant the lock after a user gesture, so retry on touch.
  document.addEventListener("pointerdown", () => { if (!wakeLock) requestWakeLock(); });

  /* ---------- Geometry ---------- */
  let geo = null;
  function computeGeometry() {
    const { from, to } = state.range;
    const count = to - from + 1;
    const avail = wrap.clientWidth || window.innerWidth;
    const spacing = (avail - SIDE_PAD * 2) / (count <= FIT_COUNT ? count : 20);
    const width = SIDE_PAD * 2 + spacing * count;
    const arcH = Math.max(22, Math.min(spacing * 0.75, 70));
    const longest = Math.max(String(from).length, String(to).length);
    // Pick how often to write a number so the labels stay readable.
    let labelStep = 1;
    for (const step of [1, 2, 5, 10, 20]) {
      labelStep = step;
      if (fitFont(spacing * step, longest) >= MIN_FONT) break;
    }
    const fontSize = Math.min(46, labelStep === 1 ? spacing * 0.8 : fitFont(spacing * labelStep, longest));
    const labelR = Math.max(9, Math.min(spacing * 0.3, 15));
    const lineY = arcH + labelR * 2 + 30;
    const numY = lineY + 20 + fontSize * 0.75;
    const height = numY + fontSize * 0.9 + 10;
    return {
      width, height, spacing, arcH, fontSize, labelR, lineY, numY, labelStep,
      x: (n) => SIDE_PAD + spacing * (n - from + 0.5),
    };
  }

  // Largest font whose label of `chars` characters fits in `room` px (Fredoka digits ≈ 0.62em).
  function fitFont(room, chars) {
    return (room * 0.86) / (chars * 0.62);
  }

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  /* ---------- Rendering ---------- */
  let arcsLayer = null;
  const cols = new Map();

  function renderAxis() {
    geo = computeGeometry();
    const { width, height, lineY, numY, fontSize, spacing } = geo;
    const { from, to } = state.range;
    svg.innerHTML = "";
    cols.clear();
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // Main line with arrows at both ends, and the − / + signs like on paper.
    const ink = "#2b2f36";
    el("line", { x1: 8, y1: lineY, x2: width - 8, y2: lineY, stroke: ink, "stroke-width": 3.5, "stroke-linecap": "round" }, svg);
    el("path", { d: `M 22 ${lineY - 9} L 8 ${lineY} L 22 ${lineY + 9}`, fill: "none", stroke: ink, "stroke-width": 3.5, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
    el("path", { d: `M ${width - 22} ${lineY - 9} L ${width - 8} ${lineY} L ${width - 22} ${lineY + 9}`, fill: "none", stroke: ink, "stroke-width": 3.5, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
    const sign = (x, s) => {
      const t = el("text", { x, y: lineY - 26, "text-anchor": "middle", "font-size": 26, "font-family": "Fredoka, sans-serif", fill: ink }, svg);
      t.textContent = s;
    };
    sign(14, "−");
    sign(width - 14, "+");

    arcsLayer = el("g", { class: "arcs" }, svg);

    for (let n = from; n <= to; n++) {
      const x = geo.x(n);
      const g = el("g", { class: "col", role: "button", tabindex: 0, "aria-label": String(n), "data-n": n }, svg);
      el("rect", { class: "hit", x: x - spacing / 2, y: 0, width: spacing, height: geo.height }, g);
      // Small tick under each number, like in the notebook.
      el("line", { x1: x, y1: lineY - 11, x2: x, y2: lineY + 11, stroke: ink, "stroke-width": 2.5, "stroke-linecap": "round" }, g);
      const pop = el("g", { class: "pop" }, g);
      if (n % geo.labelStep !== 0) {
        // Crowded axis: unlabelled numbers are marked with a dot on the line when counted.
        el("circle", { class: "bubble", cx: x, cy: lineY, r: Math.max(3, Math.min(spacing * 0.42, 8)), fill: lineColor(n) }, pop);
        cols.set(n, g);
        continue;
      }
      const bubble = el("circle", { class: "bubble", cx: x, cy: numY, fill: softColor(n), stroke: lineColor(n), "stroke-width": 2.5 }, pop);
      const label = String(n).replace("-", "−");
      const t = el("text", { class: "num", x, y: numY, "font-size": fontSize, fill: textColor(n) }, pop);
      t.textContent = label;
      // Shrink long labels (e.g. 100, −20) so neighbours never touch.
      const maxW = spacing * geo.labelStep * 0.82;
      const w = t.getComputedTextLength();
      let fs = fontSize;
      if (w > maxW) {
        fs = fontSize * (maxW / w);
        t.setAttribute("font-size", fs);
      }
      // The bubble stays inside the number's own column.
      bubble.setAttribute("r", Math.min(spacing * geo.labelStep * 0.44, Math.max(fs * 0.85, Math.min(w, maxW) / 2 + 6)));
      cols.set(n, g);
    }

    renderCount();
  }

  function arcPath(a, b) {
    const { lineY, arcH } = geo;
    const y = lineY - 14;
    const x1 = geo.x(a), x2 = geo.x(b);
    const xm = (x1 + x2) / 2;
    const cy = y - arcH * 2; // quadratic curve peaks at y - arcH
    return { d: `M ${x1} ${y} Q ${xm} ${cy} ${x2} ${y}`, x2, y, xm, cy, peakY: y - arcH };
  }

  function renderCount(animateLast = false) {
    const { seq } = state;
    arcsLayer.innerHTML = "";

    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1], b = seq[i];
      const color = lineColor(b);
      const p = arcPath(a, b);
      const isNew = animateLast && i === seq.length - 1;
      const path = el("path", { class: "arc" + (isNew ? " new" : ""), d: p.d, stroke: color }, arcsLayer);
      if (isNew) {
        const len = path.getTotalLength();
        path.style.strokeDasharray = len;
        path.style.setProperty("--len", len);
      }
      // Arrow head showing the jump direction.
      const vx = p.x2 - p.xm, vy = p.y - p.cy;
      const vl = Math.hypot(vx, vy);
      const ux = vx / vl, uy = vy / vl;
      const s = 9;
      const left = `${p.x2 - ux * s - uy * s * 0.7} ${p.y - uy * s + ux * s * 0.7}`;
      const right = `${p.x2 - ux * s + uy * s * 0.7} ${p.y - uy * s - ux * s * 0.7}`;
      el("path", { d: `M ${left} L ${p.x2} ${p.y} L ${right}`, fill: "none", stroke: color, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }, arcsLayer);
      // Jump number on top of the arc (on a crowded axis only every few jumps, and always the last).
      const every = Math.ceil((geo.labelR * 2 + 4) / geo.spacing);
      const lastJump = seq.length - 1;
      if (i !== lastJump && (i % every !== 0 || lastJump - i < every)) continue;
      const lg = el("g", { class: "arc-label" }, arcsLayer);
      el("circle", { cx: p.xm, cy: p.peakY - geo.labelR + 2, r: geo.labelR, stroke: color }, lg);
      const t = el("text", { x: p.xm, y: p.peakY - geo.labelR + 2, "font-size": geo.labelR * 1.15, fill: textColor(b) }, lg);
      t.textContent = i;
    }

    const counted = new Set(seq);
    for (const [n, g] of cols) {
      g.classList.toggle("counted", counted.has(n));
      g.classList.toggle("start", seq[0] === n);
      g.setAttribute("aria-pressed", counted.has(n) ? "true" : "false");
    }

    const jumps = Math.max(0, seq.length - 1);
    $("jumpCount").textContent = jumps;
    const eq = $("equation");
    if (jumps > 0) {
      const start = seq[0], end = seq[seq.length - 1];
      const fmt = (v) => (v < 0 ? `(${String(v).replace("-", "−")})` : String(v));
      eq.textContent = `${fmt(start)} ${state.dir > 0 ? "+" : "−"} ${jumps} = ${String(end).replace("-", "−")}`;
    } else {
      eq.textContent = "";
    }
    $("undoBtn").disabled = seq.length === 0;
  }

  function flash(n, cls, ms) {
    const g = cols.get(n);
    if (!g) return;
    g.classList.remove(cls);
    void g.getBoundingClientRect(); // restart the CSS animation
    g.classList.add(cls);
    setTimeout(() => g.classList.remove(cls), ms);
  }

  function say(text, kind = "") {
    messageEl.textContent = text;
    messageEl.className = "message" + (kind ? " " + kind : "");
  }

  // On a long, scrollable axis keep the number being counted (or hinted) in view.
  function scrollIntoViewIfNeeded(n) {
    if (wrap.scrollWidth <= wrap.clientWidth) return;
    const x = geo.x(n);
    const margin = geo.spacing * 2;
    if (x < wrap.scrollLeft + margin || x > wrap.scrollLeft + wrap.clientWidth - margin) {
      wrap.scrollTo({ left: x - wrap.clientWidth / 2, behavior: "smooth" });
    }
  }

  /* ---------- Counting rules ---------- */
  function wrong(clicked, expected) {
    playError();
    flash(clicked, "wrong", 450);
    const valid = expected.filter((n) => cols.has(n));
    valid.forEach((n) => flash(n, "hint", 3100));
    if (valid.length === 0) {
      say("הגענו לסוף הציר! אפשר ללחוץ על ניקוי ולהתחיל מחדש", "error");
    } else if (valid.length === 1) {
      say(`אופס! סופרים לפי הסדר – המספר הבא הוא ${valid[0]}`, "error");
      scrollIntoViewIfNeeded(valid[0]);
    } else {
      say(`אופס! סופרים לפי הסדר – ממשיכים ל-${valid.join(" או ל-")}`, "error");
    }
  }

  function countTo(n) {
    state.seq.push(n);
    playCount(state.seq.length - 1);
    renderCount(true);
    flash(n, "just", 400);
    scrollIntoViewIfNeeded(n);
  }

  function onNumber(n) {
    const { seq } = state;

    if (seq.length === 0) {
      countTo(n);
      say(`מתחילים מ-${n}. עכשיו לוחצים על המספר הבא (למעלה או למטה)`, "ok");
      return;
    }

    const last = seq[seq.length - 1];
    if (n === last) {
      flash(n, "just", 400); // a double tap should never lose progress
      return;
    }

    if (seq.length === 1) {
      if (Math.abs(n - last) === 1) {
        state.dir = Math.sign(n - last);
        countTo(n);
        say(state.dir > 0 ? "סופרים קדימה ➡️ (מוסיפים)" : "סופרים אחורה ⬅️ (מחסירים)", "ok");
      } else {
        wrong(n, [last - 1, last + 1]);
      }
      return;
    }

    const expected = last + state.dir;
    if (n === expected) {
      countTo(n);
      say(`כל הכבוד! ${seq.length - 1} קפיצות`, "ok");
    } else {
      wrong(n, [expected]);
    }
  }

  function undo() {
    if (state.seq.length === 0) return;
    state.seq.pop();
    if (state.seq.length <= 1) state.dir = 0;
    renderCount();
    say(state.seq.length ? "חזרנו צעד אחד אחורה" : "לחצו על מספר כדי להתחיל לספור");
  }

  function clearAll(silent = false) {
    state.seq = [];
    state.dir = 0;
    if (!silent) playClear();
    renderCount();
    say("לחצו על מספר כדי להתחיל לספור");
  }

  /* ---------- Settings ---------- */
  function renderPresets() {
    const box = $("presets");
    box.innerHTML = "";
    for (const p of PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (p.from === state.range.from && p.to === state.range.to ? " active" : "");
      b.textContent = `${p.from} – ${p.to}`.replace(/-(\d)/g, "−$1");
      b.addEventListener("click", () => setRange(p));
      box.appendChild(b);
    }
    $("fromInput").value = state.range.from;
    $("toInput").value = state.range.to;
  }

  function setRange(r) {
    const v = validRange(r);
    if (!v) {
      $("rangeError").textContent = `המספר "עד" צריך להיות גדול מ"מ-", ועד ${MAX_SPAN} מספרים בציר`;
      return;
    }
    $("rangeError").textContent = "";
    state.range = v;
    storage.set("range", v);
    renderPresets();
    clearAll(true);
    showSettings(false);
    wrap.scrollLeft = 0;
  }

  /* ---------- Events ---------- */
  // "click" (not pointerdown) so a swipe across the screen doesn't count numbers.
  svg.addEventListener("click", (e) => {
    const g = e.target.closest(".col");
    if (!g) return;
    onNumber(Number(g.dataset.n));
  });
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const g = e.target.closest(".col");
    if (!g) return;
    e.preventDefault();
    onNumber(Number(g.dataset.n));
  });

  $("undoBtn").addEventListener("click", undo);
  $("clearBtn").addEventListener("click", () => clearAll());
  $("applyRange").addEventListener("click", () => {
    setRange({ from: parseInt($("fromInput").value, 10), to: parseInt($("toInput").value, 10) });
  });
  function showSettings(show) {
    $("settings").hidden = !show;
    $("settingsBtn").setAttribute("aria-expanded", String(show));
    renderAxis();
  }
  $("settingsBtn").addEventListener("click", () => showSettings($("settings").hidden));
  const soundBtn = $("soundBtn");
  function syncSoundBtn() {
    soundBtn.textContent = state.sound ? "🔊" : "🔇";
    soundBtn.setAttribute("aria-pressed", String(state.sound));
  }
  soundBtn.addEventListener("click", () => {
    state.sound = !state.sound;
    storage.set("sound", state.sound);
    syncSoundBtn();
    if (state.sound) playCount(0);
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAxis, 80);
  });

  syncSoundBtn();
  renderPresets();
  renderAxis();
  requestWakeLock();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(renderAxis);
})();
