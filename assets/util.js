// util.js — DOM helpers, Japanese rendering, CSV, speech, clipboard.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const isKanji = (ch) => /[一-龯㐀-䶿々]/.test(ch);

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

// Japanese markup: {漢字|かんじ} gives a reading. Kanji you know (WaniKani Guru+)
// show plain; anything with an unknown kanji gets furigana. Every kanji is tappable.
export function renderJa(text, known) {
  const src = String(text ?? "");
  const parts = [];
  const re = /\{([^|{}]+)\|([^{}]+)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push({ base: src.slice(last, m.index) });
    parts.push({ base: m[1], reading: m[2] });
    last = re.lastIndex;
  }
  if (last < src.length) parts.push({ base: src.slice(last) });

  return parts
    .map((p) => {
      const chars = [...p.base];
      const inner = chars
        .map((ch) =>
          isKanji(ch)
            ? `<span class="kj ${known && known.has(ch) ? "kj-known" : "kj-new"}" data-kanji="${esc(ch)}">${esc(ch)}</span>`
            : esc(ch)
        )
        .join("");
      if (!p.reading) return inner;
      const needs = chars.some((ch) => isKanji(ch) && !(known && known.has(ch)));
      return needs ? `<ruby>${inner}<rt>${esc(p.reading)}</rt></ruby>` : inner;
    })
    .join("");
}

export const stripMarkup = (text) => String(text ?? "").replace(/\{([^|{}]+)\|([^{}]+)\}/g, "$1");
export const readingOf = (text) => String(text ?? "").replace(/\{([^|{}]+)\|([^{}]+)\}/g, "$2");

export function kanjiIn(text) {
  return [...new Set([...stripMarkup(text)].filter(isKanji))];
}

// RFC-4180-ish CSV parser (handles quotes, commas and newlines inside quotes).
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows
    .slice(1)
    .filter((r) => r.some((v) => v.trim() !== ""))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
}

// Speech: uses the device's built-in Japanese voice (free, works offline).
// Chrome quirks handled here: speak() right after cancel() can be swallowed, utterances
// can be garbage-collected mid-sentence, and the online "Google" voice can fail silently.
// So: prefer an on-device voice, pause briefly after cancel, keep a reference, and if
// nothing starts within a moment, retry with the next Japanese voice.
let voiceIndex = 0;
let current = null; // keeps the utterance alive until it finishes

function jaVoices() {
  if (!("speechSynthesis" in window)) return [];
  const all = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.replace("_", "-").toLowerCase().startsWith("ja"));
  const preferred = store.get("jh.voice", "");
  return all.sort((a, b) => {
    const score = (v) => (v.name === preferred ? -10 : 0) + (v.localService ? 0 : 5) + (/Kyoko|Otoya|O-ren|Haruka|Ayumi|Ichiro|Nanami/.test(v.name) ? -1 : 0);
    return score(a) - score(b);
  });
}
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}

export function voiceNames() {
  return jaVoices().map((v) => `${v.name}${v.localService ? "" : " (online)"}`);
}

export function speak(text, rate = 0.9) {
  if (!("speechSynthesis" in window)) return false;
  const voices = jaVoices();
  const say = (attempt) => {
    const u = new SpeechSynthesisUtterance(stripMarkup(text));
    u.lang = "ja-JP";
    u.rate = rate;
    u.volume = 1;
    const v = voices.length ? voices[(voiceIndex + attempt) % voices.length] : null;
    if (v) u.voice = v;
    let started = false;
    u.onstart = () => {
      started = true;
      if (v) {
        voiceIndex = (voiceIndex + attempt) % voices.length; // remember the voice that worked
        store.set("jh.voice", v.name);
      }
    };
    u.onend = u.onerror = () => {
      if (current === u) current = null;
    };
    current = u;
    speechSynthesis.speak(u);
    // Some browsers report "speaking" but never start. Retry once per other voice.
    setTimeout(() => {
      if (!started && current === u && attempt + 1 < Math.max(1, voices.length)) {
        speechSynthesis.cancel();
        setTimeout(() => say(attempt + 1), 80);
      }
    }, 1200);
  };
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    setTimeout(() => say(0), 80);
  } else {
    if (speechSynthesis.paused) speechSynthesis.resume();
    say(0);
  }
  return true;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {}
    ta.remove();
    return ok;
  }
}

export function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

export const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

export function daysUntil(dateStr, now = new Date()) {
  const target = new Date(dateStr + "T00:00:00");
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

export function dayOfYear(now = new Date()) {
  return Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
}
