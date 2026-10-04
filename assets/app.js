// app.js — the hub. Static, no server: WaniKani + your Sheet + lesson files, combined in the browser.
import * as core from "./core.js";
import { esc, renderJa, findWords, stripMarkup, kanjiIn, parseCSV, speak, voiceNames, copyText, toast, store, fmt, daysUntil, dayOfYear } from "./util.js";
import * as srs from "./srs.js";
import { lineChart, barChart, stackBar, heatmap, meter, shortDate, setChartWidth } from "./charts.js";

const DEMO = new URLSearchParams(location.search).has("demo");
if (DEMO) srs.useDemo();
const CACHE_MIN = 10;
const S = {
  config: null,
  raw: null,
  rawAt: null,
  model: null,
  known: new Set(),
  kanjiInfo: new Map(),
  stageBySubject: new Map(),
  history: [],
  notes: null,
  notesError: null,
  lessonsIndex: [],
  lessonCache: new Map(),
  bankCache: new Map(),
  imm: { picks: { weeks: [] }, archive: [] },
  words: new Map(), // WaniKani vocabulary: word → {r, m, s, l}
  vocabMeta: null,
  immQuery: "",
  immFilter: "all",
  session: null,
  curriculum: null,
  scenes: [],
  sceneQuery: "",
  practice: null, // {sceneId, mode, i}
  vocSession: null,
  selftalk: [],
  error: null,
  loading: false,
};

const $app = () => document.getElementById("view");
const todayKey = () => core.localDateKey(new Date(), S.config.timeZone);
const isDone = (id) => srs.isEnrolled(id);
const token = () => (DEMO ? "demo" : store.get("jh.token", ""));

// ---------------- boot ----------------

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function boot() {
  const [config, idx, curriculum, scenes, selftalk] = await Promise.all([
    getJSON("data/config.json"),
    getJSON("data/lessons/index.json"),
    getJSON("data/curriculum.json"),
    loadScenes(),
    getJSON("data/selftalk.json"),
  ]);
  // Follow the travel schedule: "today" resets at local midnight wherever you are.
  config.homeTimeZone = config.timeZone;
  config.timeZone = core.timeZoneFor(config);
  S.config = config;
  S.lessonsIndex = idx.lessons;
  S.curriculum = curriculum;
  S.scenes = scenes;
  S.selftalk = selftalk.prompts;

  window.addEventListener("hashchange", render);
  let lastW = window.innerWidth;
  window.addEventListener("resize", () => {
    if (Math.abs(window.innerWidth - lastW) > 40 && !location.hash.startsWith("#course/")) {
      lastW = window.innerWidth;
      render();
    }
  });
  wireGlobal();
  wireResume();

  // Show cached WaniKani data instantly, then refresh in the background.
  const cached = DEMO ? null : store.get("jh.wk", null);
  if (cached) {
    S.raw = cached.raw;
    S.rawAt = cached.at;
    buildModel();
  }
  render();
  await Promise.all([loadHistory(), loadNotes(), loadReviews(), loadImmersion(), loadVocab()]);
  if (S.raw) buildModel();
  render();
  await refreshWK(false);
}

// A home-screen web app is resumed, not reloaded, when you open it again — so it can still be
// showing yesterday. Coming back on a new day (or after a long break) reloads the whole page,
// which also picks up any new code and lessons. A short break just refreshes WaniKani.
function wireResume() {
  let hiddenAt = null;
  let dayAtHide = null;
  const comeBack = () => {
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    const newDay = dayAtHide && S.config && todayKey() !== dayAtHide;
    hiddenAt = null;
    if (newDay || away > 60 * 60000) return location.reload();
    if (away > 2 * 60000) {
      refreshWK(false);
      render();
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      dayAtHide = S.config ? todayKey() : null;
    } else comeBack();
  });
  // Restored from the back/forward cache (Safari does this too).
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      hiddenAt = hiddenAt || Date.now() - 2 * 3600000;
      comeBack();
    }
  });
}

async function loadScenes() {
  const idx = await getJSON("data/scenes/index.json");
  const all = await Promise.all(idx.scenes.map((e) => getJSON(`data/scenes/${e.file}`).catch(() => null)));
  return all.filter(Boolean);
}

async function loadReviews() {
  await srs.load(S.config.syncUrl);
  // Lessons marked done before reviews existed join the review queue.
  const old = store.get("jh.course", {});
  for (const [id, rec] of Object.entries(old)) {
    if (rec?.done && !srs.state.rows.has(id) && S.lessonsIndex.some((l) => l.id === id)) await srs.enroll(id, todayKey(), S.config.syncUrl);
  }
}

// Raw GitHub copies update minutes after the nightly job; the Pages copy can lag.
const rawUrl = (path) => S.config.historyUrl.replace("data/history.json", path);

async function loadVocab() {
  let data = null;
  if (DEMO) {
    data = {
      words: [
        { w: "電車", r: "でんしゃ", m: "Train", s: 7, l: 3 },
        { w: "駅員", r: "えきいん", m: "Station Staff", s: 3, l: 9 },
        { w: "雨", r: "あめ", m: "Rain", s: 8, l: 2 },
        { w: "図書館", r: "としょかん", m: "Library", s: 5, l: 9 },
        { w: "作曲", r: "さっきょく", m: "Composition", s: 6, l: 10 },
      ],
    };
  } else {
    for (const url of [rawUrl("data/wk-vocab.json") + "?t=" + Date.now(), "data/wk-vocab.json"]) {
      try {
        data = await getJSON(url);
        break;
      } catch {}
    }
  }
  if (!data) return;
  S.vocabMeta = { updated: data.updated, count: data.words.length, guru: data.words.filter((v) => v.s >= 5).length };
  S.words = new Map(data.words.map((v) => [v.w, v]));
}

// "From WaniKani" status for a word (markup allowed).
function wordStatus(text) {
  const w = stripMarkup(text).replace(/[〜~]/g, "");
  const v = S.words.get(w);
  if (!v) return { known: false, cls: "new", label: "New" };
  if (v.s >= 5) return { known: true, cls: "wk", label: `WaniKani · ${stageName(v.s)}`, v };
  return { known: false, cls: "learning", label: `Learning · ${stageName(v.s)}`, v };
}

// How much of a set of sentences you already know, word by word.
function wordCoverage(texts) {
  const seen = new Map();
  for (const t of texts) for (const h of findWords(stripMarkup(t), S.words)) seen.set(h.word, h.info);
  const all = [...seen.values()];
  return { total: all.length, known: all.filter((v) => v.s >= 5).length };
}

async function loadImmersion() {
  if (DEMO) {
    S.imm = demoImmersion();
    return;
  }
  for (const [key, path, fallback] of [
    ["picks", "data/immersion/picks.json", { weeks: [] }],
    ["archive", "data/immersion/archive.json", []],
  ]) {
    let val = null;
    for (const url of [rawUrl(path) + "?t=" + Date.now(), path]) {
      try {
        val = await getJSON(url);
        break;
      } catch {}
    }
    S.imm[key] = val || fallback;
  }
}

function demoImmersion() {
  const ex = (i, t, src, lvl, min) => ({ id: "demo" + i, title: t, url: "https://example.com/" + i, sourceName: src, level: lvl, minutes: min, type: "listen", date: new Date(Date.now() - i * 86400000).toISOString(), summary: "Demo episode", tags: ["learner"] });
  return {
    picks: {
      weeks: [
        {
          week: "2026-10-05",
          note: "Trains and travel, to go with this week's に vs で.",
          picks: [
            { id: "p1", title: "#120 電車の旅", url: "https://example.com/p1", type: "listen", source: "Nihongo con Teppei", minutes: 8, level: 1, why: "Short and slow, all about taking trains.", connection: "**Ties to this week:** に vs で — trains are full of both.", listenFor: "Every time you hear **で** after a place, ask: what's happening there? Every **に** after a place: is someone arriving, or just being there?", prep: [{ ja: "{電車|でんしゃ}", en: "train" }, { ja: "{乗|の}り{換|か}え", en: "transfer" }, { ja: "{駅員|えきいん}", en: "station staff" }], tags: ["travel"] },
            { id: "p2", title: "作曲家に聞く", url: "https://example.com/p2", type: "listen", source: "NHK-FM 現代の音楽", minutes: 50, level: 4, why: "A composer talking about their work. Listen for familiar words, not every word.", listenFor: "Catch **〜ています** — what is the composer doing these days?", prep: [{ ja: "{作曲|さっきょく}", en: "composition" }, { ja: "{初演|しょえん}", en: "premiere" }], tags: ["music"] },
          ],
        },
      ],
    },
    archive: [ex(1, "#121 旅館のはなし", "Nihongo con Teppei (beginner)", 1, 6), ex(2, "ワールドリポート：パリ", "ワールドリポート（NHKラジオ マイあさ！）", 4, 5), ex(3, "雨の日の過ごし方", "YUYUの日本語Podcast", 2, 14)],
  };
}

async function loadHistory() {
  if (DEMO) {
    const { demoHistory } = await import("./demo.js");
    S.history = demoHistory();
    return;
  }
  for (const url of [S.config.historyUrl + "?t=" + Date.now(), "data/history.json"]) {
    try {
      const h = await getJSON(url);
      if (Array.isArray(h)) {
        S.history = h;
        return;
      }
    } catch {}
  }
}

async function loadNotes() {
  const cached = store.get("jh.notes", null);
  if (cached) S.notes = cached;
  if (!S.config.sheetCsv) return;
  try {
    const res = await fetch(S.config.sheetCsv, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    const rows = parseCSV(await res.text());
    S.notes = rows;
    S.notesError = null;
    store.set("jh.notes", rows);
  } catch (e) {
    S.notesError = "Couldn't reach your Sheet just now" + (cached ? " — showing the last copy." : ".");
  }
}

async function refreshWK(force) {
  if (!token()) return;
  const fresh = S.rawAt && Date.now() - S.rawAt < CACHE_MIN * 60000;
  if (fresh && !force) return;
  S.loading = true;
  S.error = null;
  setStatus();
  try {
    if (DEMO) {
      const { demoRaw } = await import("./demo.js");
      S.raw = demoRaw();
    } else {
      S.raw = await core.fetchRaw(token());
      store.set("jh.wk", { at: Date.now(), raw: slimRaw(S.raw) });
    }
    S.rawAt = Date.now();
    buildModel();
  } catch (e) {
    S.error = e.message || String(e);
  }
  S.loading = false;
  render();
}

// Keep the browser cache small: only the fields the hub reads.
function slimRaw(raw) {
  return {
    user: { data: { level: raw.user.data.level, username: raw.user.data.username } },
    summary: raw.summary,
    assignments: raw.assignments.map((a) => ({
      data: {
        subject_id: a.data.subject_id,
        subject_type: a.data.subject_type,
        srs_stage: a.data.srs_stage,
        available_at: a.data.available_at,
      },
    })),
    stats: raw.stats.map((s) => ({ data_updated_at: s.data_updated_at, data: s.data })),
    levels: raw.levels.map((l) => ({ data: l.data })),
    kanjiSubjects: raw.kanjiSubjects.map((k) => ({
      id: k.id,
      data: {
        characters: k.data.characters,
        level: k.data.level,
        meanings: k.data.meanings,
        readings: k.data.readings,
        document_url: k.data.document_url,
      },
    })),
    leechSubjects: raw.leechSubjects.map((k) => ({
      id: k.id,
      object: k.object,
      data: {
        characters: k.data.characters,
        slug: k.data.slug,
        level: k.data.level,
        meanings: k.data.meanings,
        readings: k.data.readings,
        document_url: k.data.document_url,
      },
    })),
  };
}

// ---------------- model ----------------

function buildModel() {
  const raw = S.raw;
  const tz = S.config.timeZone;
  const now = new Date();
  const q = core.queueNow(raw.summary, now, raw.assignments);
  const target = core.dailyTarget(q.reviews);
  const live = core.snapshotRow(raw, tz, now);
  // Baseline: last night's snapshot if there is one; otherwise the first time
  // this device saw your numbers today (so reviews before that aren't counted).
  const liveMC = live.meaning[0];
  const prev = core.previousDayRow(S.history, live.date, tz);
  let dayBase = prev ? prev.meaning[0] : null;
  let baseSource = prev ? "snapshot" : "device";
  if (dayBase == null && !raw.demo) {
    // No snapshot from last night. Use the earliest number we have for today: an
    // earlier snapshot from today (shared by every device) or this device's first look.
    const saved = store.get("jh.base", null);
    let deviceBase = saved && saved.date === live.date && saved.mc <= liveMC ? saved.mc : null;
    if (deviceBase == null) {
      deviceBase = liveMC;
      store.set("jh.base", { date: live.date, mc: liveMC });
    }
    const todayRow = S.history.find((h) => h.date === live.date && Array.isArray(h.meaning) && h.meaning[0] <= liveMC);
    dayBase = todayRow ? Math.min(todayRow.meaning[0], deviceBase) : deviceBase;
    if (todayRow && todayRow.meaning[0] <= deviceBase) baseSource = "earlier-snapshot";
  }
  if (dayBase == null) dayBase = liveMC - 73; // demo only
  const done = Math.max(0, liveMC - dayBase);
  live.reviewedToday = done;

  S.known = core.knownKanji(raw.assignments, raw.kanjiSubjects);
  S.stageBySubject = new Map(raw.assignments.map((a) => [a.data.subject_id, a.data.srs_stage]));
  S.kanjiInfo = new Map(raw.kanjiSubjects.map((k) => [k.data.characters, { ...k.data, id: k.id }]));

  const subj = new Map([...raw.kanjiSubjects, ...raw.leechSubjects].map((s) => [s.id, s]));
  const leeches = core.findLeeches(raw.stats, raw.assignments, 12).map((l) => ({ ...l, subject: subj.get(l.subject_id) || null }))
    .filter((l) => l.subject);

  // History merged with today's live numbers.
  const hist = S.history.filter((h) => h.date !== live.date).concat([live]).sort((a, b) => a.date.localeCompare(b.date));
  const weekAgoKey = core.localDateKey(new Date(now.getTime() - 7 * 86400000), tz);
  const base = [...hist].reverse().find((h) => h.date <= weekAgoKey) || (hist.length > 1 ? hist[0] : null);
  const between = base && base.date !== live.date ? core.accuracyBetween(base, live) : null;
  const week = between ? { ...between, since: base.date } : null;

  S.model = {
    username: raw.user.data.username,
    level: raw.user.data.level,
    queue: q.reviews,
    lessons: q.lessons,
    target,
    done,
    baseSource,
    srs: core.srsBreakdown(raw.assignments),
    acc: core.accuracyTotals(raw.stats),
    week,
    leeches,
    pace: core.levelPace(raw.levels, now),
    forecast: core.forecast(raw.assignments, tz, 7, now),
    hist,
    live,
  };
}

// ---------------- shared bits ----------------

const stageName = (s) =>
  s == null ? "Not unlocked yet" : s === 0 ? "In lessons" : s <= 4 ? `Apprentice ${s}` : s <= 6 ? `Guru ${s - 4}` : s === 7 ? "Master" : s === 8 ? "Enlightened" : "Burned";

function ja(text, cls = "") {
  return `<span class="ja ${cls}" lang="ja">${renderJa(text, S.known, S.words)}</span>`;
}
function rich(text) {
  return renderJa(text, S.known, S.words).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

function sayBtn(text) {
  return `<button class="icon-btn say" data-say="${esc(stripMarkup(text))}" aria-label="Play audio" title="Play audio">${ICON.sound}</button>`;
}

// A Japanese-first line: Japanese shown, English behind a tap.
function jaCard(item, { extra = "" } = {}) {
  return `<div class="jcard">
    <div class="jline">${ja(item.ja, "big")} ${sayBtn(item.ja)}</div>
    <button class="reveal" aria-expanded="false">Show English</button>
    <div class="hidden-en">
      <p class="en">${esc(item.en)}</p>
      ${item.note ? `<p class="note">${rich(item.note)}</p>` : ""}
      ${extra}
    </div>
  </div>`;
}

const ICON = {
  sound: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>`,
  ask: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 4h16v12H7l-3 3V4zm8 2.5a2.6 2.6 0 0 0-2.7 2.4h1.6c.1-.6.5-1 1.1-1 .6 0 1.1.4 1.1 1 0 .9-1.6 1-1.6 2.6v.4h1.5v-.3c0-1.1 1.7-1.3 1.7-2.8 0-1.4-1.2-2.3-2.7-2.3zm-.8 7v1.6h1.6v-1.6h-1.6z"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17.6 6.4A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4l-2.4 2.4z"/></svg>`,
};

function setStatus() {
  const el = document.getElementById("status");
  if (!el) return;
  if (DEMO) el.textContent = "Demo data";
  else if (S.loading) el.textContent = "Updating…";
  else if (S.rawAt) {
    const m = Math.round((Date.now() - S.rawAt) / 60000);
    el.textContent = m < 1 ? "Updated just now" : `Updated ${m} min ago`;
  } else el.textContent = "";
}

function needToken() {
  return `<section class="card setup">
    <h2>Connect WaniKani</h2>
    <p>Paste your read-only API token once on this device. It stays in this browser and is never sent anywhere except WaniKani.</p>
    <a class="btn" href="#settings">Add token</a>
    <p class="muted small">Just looking? <a href="?demo">Preview with demo data</a>.</p>
  </section>`;
}

function errorBanner() {
  return S.error ? `<div class="banner">${esc(S.error)} ${S.raw ? "Showing your last saved numbers." : ""}</div>` : "";
}

// ---------------- views ----------------

function viewToday() {
  const days = daysUntil(S.config.tripDate);
  const hour = new Date().getHours();
  const greet = hour < 11 ? "おはよう" : hour < 18 ? "こんにちは" : "こんばんは";
  const top = `<header class="today-head">
    <p class="greet" lang="ja">${greet}</p>
    <p class="countdown"><span lang="ja">${esc(S.config.tripLabel === "Japan" ? "日本" : S.config.tripLabel)}まで</span> <b>${fmt(days)}</b> <span lang="ja">日</span></p>
  </header>`;

  if (!token()) return top + needToken() + grammarCard() + sceneTodayCard() + lessonCard() + selftalkCard();
  if (!S.model) return top + errorBanner() + `<section class="card"><p class="muted">Loading your WaniKani…</p></section>`;
  const m = S.model;
  const t = m.target;
  const doneN = Math.min(m.done, Math.max(t.target, m.done));
  const pctDone = t.target ? Math.min(100, Math.round((m.done / t.target) * 100)) : 100;
  const msg =
    t.mode === "clear"
      ? "Queue's empty. Nothing due — enjoy it."
      : t.mode === "maintain"
      ? `Clear the queue (${fmt(m.queue)}). Lessons are open again.`
      : `Then stop. Small, steady chunks dig you out.`;
  const metTarget = t.target && m.done >= t.target;

  const target = `<section class="card hero">
    <p class="eyebrow">Today's goal</p>
    <div class="hero-row">
      <div>
        <p class="hero-num">${t.target ? fmt(t.target) : "0"}</p>
        <p class="hero-label">${t.target ? "reviews to do" : "reviews due"}</p>
      </div>
      <div class="ring-wrap" aria-label="${fmt(doneN)} reviewed so far, ${pctDone}% of the goal">
        ${ring(pctDone)}
        <span class="ring-label"><b>${fmt(doneN)}</b><br><small>done</small></span>
      </div>
    </div>
    <p class="small"><b>${fmt(doneN)}</b> reviewed so far today${t.target ? ` · ${fmt(Math.max(0, t.target - m.done))} to go` : ""}.</p>
    ${
      m.baseSource === "device"
        ? `<p class="muted small">Counting from when this device first opened the hub today. From tomorrow it counts from last night's snapshot.</p>`
        : m.baseSource === "earlier-snapshot"
        ? `<p class="muted small">Counting from today's earlier snapshot. From tomorrow it counts from last night's.</p>`
        : ""
    }
    <p>${metTarget ? "<b>Done for today.</b> Anything more is a bonus — and it's fine to stop." : esc(msg)}</p>
    <p class="muted small">Hard day? 20 still counts.</p>
    <div class="row">
      <a class="btn" href="https://www.wanikani.com/subjects/review" target="_blank" rel="noopener">Open reviews</a>
      ${
        t.lessonsOk
          ? `<a class="btn ghost" href="https://www.wanikani.com/subjects/lesson" target="_blank" rel="noopener">Lessons (${fmt(m.lessons)})</a>`
          : `<span class="lock">Lessons locked until the queue is under 100</span>`
      }
    </div>
  </section>`;

  const burn = m.hist.map((h) => ({ label: shortDate(h.date), value: h.queue }));
  const queueCard = `<section class="card">
    <div class="split"><h2>Queue</h2><span class="big-num">${fmt(m.queue)}</span></div>
    ${burn.length > 1 ? lineChart(burn, { height: 150, unit: " reviews" }) : `<p class="muted small">The burn-down line starts tonight, when the first daily snapshot runs.</p>`}
    <a class="more" href="#stats">All stats →</a>
  </section>`;

  const leech = m.leeches.length
    ? `<section class="card"><h2>Tricky ones</h2><p class="muted small">Your most-missed items right now. Give them a slow look before you review.</p>
      <div class="leech-row">${m.leeches.slice(0, 4).map(leechChip).join("")}</div></section>`
    : "";

  return top + errorBanner() + target + grammarCard() + sceneTodayCard() + lessonCard() + selftalkCard() + queueCard + leech;
}

function ring(p) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="${r}" class="ring-bg"/><circle cx="40" cy="40" r="${r}" class="ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${(
    c *
    (1 - p / 100)
  ).toFixed(1)}"/></svg>`;
}

function leechChip(l) {
  const s = l.subject;
  const chars = s ? s.data.characters || s.data.slug : "?";
  const meaning = s ? (s.data.meanings || []).find((x) => x.primary)?.meaning : "";
  const reading = s ? (s.data.readings || []).find((x) => x.primary)?.reading : "";
  const url = s?.data.document_url || "#";
  return `<a class="leech" href="${esc(url)}" target="_blank" rel="noopener">
    <span class="leech-ja" lang="ja">${esc(chars)}</span>
    <span class="leech-meta">${esc(meaning || "")}${reading ? ` · <span lang="ja">${esc(reading)}</span>` : ""}</span>
    <span class="leech-why">${l.weak} · ${fmt(l.incorrect)} misses</span>
  </a>`;
}

function currentLessonEntry() {
  const start = new Date(S.config.courseStart + "T00:00:00");
  const week = Math.max(1, Math.floor((Date.now() - start) / (7 * 86400000)) + 1);
  const firstOpen = S.lessonsIndex.find((l) => !isDone(l.id));
  const thisWeek = S.lessonsIndex.find((l) => l.week === week);
  return { entry: firstOpen || thisWeek || S.lessonsIndex[S.lessonsIndex.length - 1], week, allDone: !firstOpen };
}

function syncNote() {
  const st = srs.state.sync;
  if (st === "ok") return `<span class="sync ok">Synced with your Sheet</span>`;
  if (st === "syncing") return `<span class="sync">Syncing…</span>`;
  if (st === "error") return `<span class="sync bad" title="${esc(srs.state.syncError || "")}">Sheet sync failed — saved on this device</span>`;
  return `<a class="sync" href="#settings">This device only · set up Sheet sync</a>`;
}

function grammarCard() {
  const enrolled = [...srs.state.rows.values()].filter((r) => srs.isGrammar(r.id) && r.stage >= 1);
  const today = todayKey();
  if (!enrolled.length)
    return `<section class="card grammar-card"><p class="eyebrow">Grammar reviews</p>
      <p>Reviews start once you mark a lesson done. Each grammar point comes back after 1, 3, 7, 14, 30 and 90 days, with new sentences every time.</p>
      <p class="small">${syncNote()}</p></section>`;
  const due = srs.dueToday(today);
  const waiting = srs.dueList(today).length - due.length;
  if (!due.length) {
    const nd = srs.nextDue(today);
    return `<section class="card grammar-card"><p class="eyebrow">Grammar reviews</p>
      <p><b>Nothing due.</b> ${nd ? `Next one ${friendlyDate(nd)}.` : "Everything's retired — nice."}</p>
      <p class="small">${syncNote()}</p></section>`;
  }
  return `<section class="card grammar-card due"><p class="eyebrow">Grammar reviews</p>
    <div class="split"><p class="big-num">${due.length}</p><p class="muted small">point${due.length > 1 ? "s" : ""} · about ${due.length * srs.DRILLS_PER_POINT} sentences</p></div>
    <p class="small">${due.map((r) => `<span lang="ja" class="chip">${esc(lessonTitle(r.id))}</span>`).join(" ")}</p>
    ${waiting > 0 ? `<p class="muted small">${waiting} more will wait for another day. No pile-up.</p>` : ""}
    <a class="btn" href="#review">Start review</a>
    <p class="small">${syncNote()}</p></section>`;
}

function lessonTitle(id) {
  return S.lessonsIndex.find((l) => l.id === id)?.title || id;
}

function friendlyDate(key) {
  const today = todayKey();
  if (key === srs.addDays(today, 1)) return "tomorrow";
  const d = new Date(key + "T12:00:00");
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function lessonCard() {
  if (!S.lessonsIndex.length) return "";
  const { entry, allDone } = currentLessonEntry();
  return `<section class="card lesson-card">
    <p class="eyebrow">${allDone ? "All caught up" : `This week · Lesson ${entry.week}`}</p>
    <h2 lang="ja" class="lesson-title">${esc(entry.title)}</h2>
    <p class="muted">${esc(entry.titleEn)}</p>
    <p class="small">One small step a day: read it, look at the pairs, then try a few.</p>
    <a class="btn" href="#course/${esc(entry.id)}">${allDone ? "Review" : "Open lesson"}</a>
  </section>`;
}

function selftalkCard() {
  if (!S.selftalk.length) return "";
  const p = S.selftalk[dayOfYear() % S.selftalk.length];
  return `<section class="card talk">
    <p class="eyebrow" lang="ja">ひとりごと · Self-talk</p>
    <p class="talk-q">${esc(p.en)}</p>
    <p class="small muted">Answer in your head or out loud, in Japanese. Two or three sentences.</p>
    <button class="reveal" aria-expanded="false">Need a start?</button>
    <div class="hidden-en"><p>${ja(p.ja, "big")} ${sayBtn(p.ja)}</p></div>
  </section>`;
}

function viewStats() {
  if (!token()) return needToken();
  if (!S.model) return errorBanner() + `<section class="card"><p class="muted">Loading your WaniKani…</p></section>`;
  const m = S.model;
  const allAcc = core.pct(m.acc.correct, m.acc.incorrect);
  const tiles = `<section class="tiles">
    ${tile("Level", m.level, m.pace.current ? `${fmt(Math.round(m.pace.current.days))} days on it` : "")}
    ${tile("Queue", fmt(m.queue), `${fmt(m.lessons)} lessons waiting`)}
    ${tile("This week", m.week ? `${m.week.pct}%` : "—", m.week ? `${fmt(m.week.correct + m.week.incorrect)} answers since ${shortDate(m.week.since)}` : "Needs a few daily snapshots")}
    ${tile("All-time", allAcc == null ? "—" : `${allAcc}%`, "accuracy")}
    ${tile("Immersion", `${fmt(immMinutes(weekStartKey()))} min`, "this week · see Immerse")}
    ${S.vocabMeta ? tile("Words", fmt(S.vocabMeta.guru), `at Guru or higher · ${fmt(S.vocabMeta.count)} started`) : ""}
    ${sceneWordsTile()}
  </section>`;

  const groups = core.SRS_GROUPS.map((g) => ({ key: g.key, label: g.label, value: m.srs[g.key] }));
  const srsCard = `<section class="card"><h2>Where your items are</h2>${stackBar(groups)}</section>`;

  const burnPts = m.hist.map((h) => ({ label: shortDate(h.date), value: h.queue }));
  const burn = `<section class="card"><h2>Queue burn-down</h2>
    ${burnPts.length > 1 ? lineChart(burnPts, { unit: " reviews" }) : `<p class="muted">Starts tonight. A snapshot runs every evening, so this fills in day by day.</p>`}
  </section>`;

  const counts = new Map(m.hist.map((h) => [h.date, h.reviewedToday || 0]));
  const heat = `<section class="card"><h2>Days you showed up</h2>
    ${heatmap(counts, m.live.date, 12)}
    <p class="muted small">${streakText(m.hist)}</p>
  </section>`;

  const fc = m.forecast.days.map((d, i) => ({
    label: i === 0 ? "Today" : new Date(d.date + "T12:00:00").toLocaleString("en-US", { weekday: "short" }),
    value: d.count,
    tip: `${i === 0 ? "Later today" : d.date}: ${fmt(d.count)} more coming due`,
  }));
  const forecastCard = `<section class="card"><h2>Coming up</h2>
    <p class="muted small">New reviews landing on top of the ${fmt(m.forecast.overdue)} already due.</p>
    ${barChart(fc, { height: 170 })}
  </section>`;

  const types = [
    ["Radicals", m.acc.byType.radical],
    ["Kanji", m.acc.byType.kanji],
    ["Vocab", m.acc.byType.vocabulary],
    ["Meaning", m.acc.meaning],
    ["Reading", m.acc.reading],
  ];
  const accCard = `<section class="card"><h2>Accuracy</h2>
    <div class="acc-grid">${types
      .map(([label, v]) => {
        const p = core.pct(v.correct, v.incorrect);
        return `<div class="acc"><div class="split"><span>${label}</span><b>${p == null ? "—" : p + "%"}</b></div>${meter(p || 0)}</div>`;
      })
      .join("")}</div>
    <p class="muted small">All-time, from WaniKani. If reading sits well below meaning, the leeches below are probably reading problems.</p>
    ${m.week ? `<p class="small">${weekVerdict(m.week)}</p>` : ""}
  </section>`;

  const pace = m.pace;
  const daysLeft = daysUntil(S.config.tripDate);
  const proj = pace.avgRecent ? Math.floor(daysLeft / pace.avgRecent) : null;
  const paceBars = pace.done.slice(-12).map((d) => ({ label: String(d.level), value: d.days, tip: `Level ${d.level}: ${d.days} days` }));
  if (pace.current) paceBars.push({ label: `${pace.current.level}`, value: Math.round(pace.current.days), tip: `Level ${pace.current.level}: ${pace.current.days} days so far`, emphasis: true });
  const paceCard = `<section class="card"><h2>Level pace</h2>
    ${paceBars.length ? barChart(paceBars, { height: 170, refLine: pace.avgRecent ? Math.round(pace.avgRecent) : null, refLabel: "" }) : ""}
    <p class="small">${
      proj != null
        ? `Dashed line: your recent average. Dark bar: the level you're on now. At that pace (${Math.round(pace.avgRecent)} days a level), you'd be around <b>level ${m.level + proj}</b> by December 29. The dig-out comes first, so expect the next level to take longer — that's fine.`
        : "Pace shows up once you've passed a few levels."
    }</p>
  </section>`;

  const knownN = S.known.size;
  const tripKanji = [...new Set(S.scenes.flatMap(sceneTexts).flatMap((t) => kanjiIn(t)))];
  const tripKnown = tripKanji.filter((k) => S.known.has(k)).length;
  const tripPct = tripKanji.length ? Math.round((tripKnown / tripKanji.length) * 100) : 0;
  const coverage = `<section class="card two">
    <div><h2>Kanji you can read</h2><p class="big-num">${fmt(knownN)}</p>${meter(knownN, core.JOYO_COUNT)}
      <p class="muted small">Guru or higher on WaniKani · ${Math.round((knownN / core.JOYO_COUNT) * 100)}% of the 2,136 jōyō kanji</p></div>
    <div><h2>Trip readiness</h2><p class="big-num">${tripPct}%</p>${meter(tripPct)}
      <p class="muted small">${tripKnown} of ${tripKanji.length} kanji in your scenes. <a href="#scenes">See scenes →</a></p></div>
  </section>`;

  const leeches = `<section class="card"><h2>Leeches</h2>
    ${m.leeches.length ? `<div class="leech-grid">${m.leeches.map(leechChip).join("")}</div>` : `<p class="muted">No leeches. Nice.</p>`}
    <p class="muted small">Ranked by misses weighed against how shaky each item is right now.</p>
  </section>`;

  const table = `<details class="card table-view"><summary>Daily snapshots (table)</summary>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Level</th><th>Queue</th><th>Reviewed</th></tr></thead><tbody>
    ${[...m.hist].reverse().map((h) => `<tr><td>${h.date}</td><td>${h.level}</td><td>${fmt(h.queue)}</td><td>${fmt(h.reviewedToday)}</td></tr>`).join("")}
    </tbody></table></div></details>`;

  return errorBanner() + tiles + srsCard + burn + heat + forecastCard + accCard + grammarStats() + paceCard + coverage + leeches + table;
}

function grammarStats() {
  const rows = [...srs.state.rows.values()].filter((r) => srs.isGrammar(r.id) && r.stage >= 1).sort((a, b) => a.id.localeCompare(b.id));
  if (!rows.length) return "";
  return `<section class="card"><h2>Grammar</h2>
    <div class="acc-grid">${rows
      .map((r) => {
        const p = core.pct(r.right, r.wrong);
        return `<div class="acc">
          <div class="split"><span lang="ja"><b>${esc(lessonTitle(r.id))}</b></span><span class="small muted">${esc(srs.stageLabel(r.stage))}</span></div>
          ${meter(Math.min(r.stage, 6), 6)}
          <p class="small muted">${p == null ? "No reviews yet" : `${p}% right over ${fmt(r.right + r.wrong)} sentences`}${r.due ? ` · next ${friendlyDate(r.due)}` : ""}</p>
        </div>`;
      })
      .join("")}</div>
    <p class="muted small">The bar is how far along the 1 → 90 day ladder each point is.</p>
  </section>`;
}

function tile(label, value, sub) {
  return `<div class="tile"><p class="tile-label">${esc(label)}</p><p class="tile-val">${esc(String(value))}</p><p class="tile-sub">${esc(sub)}</p></div>`;
}

function weekVerdict(w) {
  if (w.pct >= 75) return `This week: <b>${w.pct}%</b>. That's solid — keep grinding the queue down.`;
  if (w.pct >= 60) return `This week: <b>${w.pct}%</b>. Workable. Slow down on misses and read the mnemonic again.`;
  return `This week: <b>${w.pct}%</b>. That's low enough that a reset to level 7 or 8 would probably save you time. Your call.`;
}

function streakText(hist) {
  const days = [...hist].reverse();
  let streak = 0;
  for (const h of days) {
    if ((h.reviewedToday || 0) > 0) streak++;
    else if (h === days[0]) continue; // today isn't over yet
    else break;
  }
  const active = hist.filter((h) => (h.reviewedToday || 0) > 0).length;
  return `${streak ? `${streak}-day run going. ` : ""}${active} active day${active === 1 ? "" : "s"} recorded.`;
}

// ---------- course ----------

function viewCourse(id) {
  if (id) return viewLesson(id);
  const lessonById = new Map(S.lessonsIndex.map((l) => [l.id, l]));
  const { entry } = currentLessonEntry();
  const sections = S.curriculum.sections
    .map(
      (sec) => `<section class="card"><h2>${esc(sec.name)}</h2><ol class="chapters">
      ${sec.chapters
        .map((c) => {
          const l = c.lesson && lessonById.get(c.lesson);
          const done = l && isDone(l.id);
          const row = l && srs.state.rows.get(l.id);
          return `<li class="${l ? "has-lesson" : ""} ${done ? "done" : ""}">
            <span class="ch-title">${esc(c.title)}</span>
            <span class="ch-links">
              ${l ? `<a class="pill ${l.id === entry.id ? "pill-em" : ""}" href="#course/${esc(l.id)}">${done ? "✓ Lesson" : "Lesson"}</a>` : ""}
              ${done ? `<span class="pill stage">${esc(srs.stageLabel(row.stage).replace(" of 6", ""))}</span>` : ""}
              <a class="pill ghost" href="${esc(c.url)}" target="_blank" rel="noopener">Tae Kim</a>
            </span>
          </li>`;
        })
        .join("")}
    </ol></section>`
    )
    .join("");
  return `<section class="card intro"><h1>Course</h1>
    <p>Tae Kim's guide sets the order. Lessons here add plain explanations, contrast pairs, and practice built from your WaniKani kanji. A new one arrives each week; a missed week just means a smaller next one.</p>
  </section>${sections}`;
}

async function loadLesson(id) {
  if (S.lessonCache.has(id)) return S.lessonCache.get(id);
  const entry = S.lessonsIndex.find((l) => l.id === id);
  if (!entry) throw new Error("No lesson called " + id);
  const lesson = await getJSON(`data/lessons/${entry.file}`);
  S.lessonCache.set(id, lesson);
  return lesson;
}

function lessonCoverage(l) {
  if (!S.words.size) return "";
  const texts = [
    ...l.examples.map((e) => e.ja),
    ...l.contrasts.flatMap((c) => [c.a.ja, c.b.ja]),
    ...l.exercises.map((x) => x.prompt || x.model || (x.tiles || []).join("")),
  ];
  const c = wordCoverage(texts);
  if (!c.total) return "";
  const learning = c.total - c.known;
  return `<p class="small muted">Vocabulary: <b>${c.known}</b> word${c.known === 1 ? "" : "s"} you know from WaniKani${learning ? `, ${learning} you're still learning` : ""}. Furigana only appears where you need it.</p>`;
}

// An exercise can only be shown if every option explains itself.
function exerciseOk(ex) {
  if (ex.type === "choice") return ex.options?.length >= 2 && ex.options.every((o) => o.why && o.why.trim()) && ex.options.some((o) => o.verdict === "right");
  if (ex.type === "build") return ex.tiles?.length && ex.answers?.length && ex.why;
  if (ex.type === "write") return ex.model && ex.why;
  return false;
}

function viewLesson(id) {
  const l = S.lessonCache.get(id);
  if (!l) {
    loadLesson(id).then(render).catch((e) => {
      $app().innerHTML = `<div class="banner">${esc(e.message)}</div>`;
    });
    return `<section class="card"><p class="muted">Opening lesson…</p></section>`;
  }
  const exercises = l.exercises.filter(exerciseOk);
  const skipped = l.exercises.length - exercises.length;
  const done = isDone(l.id);
  const row = srs.state.rows.get(l.id);
  return `<a class="back" href="#course">← Course</a>
  <article class="lesson">
    <header class="card">
      <p class="eyebrow">Lesson ${l.week}</p>
      <h1 lang="ja" class="lesson-title">${esc(l.title)}</h1>
      <p class="muted">${esc(l.titleEn)}</p>
      <p class="summary">${rich(l.summary)}</p>
      <p class="small"><a href="${esc(l.taeKim.url)}" target="_blank" rel="noopener">Tae Kim: ${esc(l.taeKim.title)} ↗</a></p>
      ${lessonCoverage(l)}
    </header>

    <section class="card"><h2>How it works</h2>${l.explanation.map((p) => `<p>${rich(p)}</p>`).join("")}</section>

    <section class="card"><h2>Examples</h2><p class="muted small">Read the Japanese first. Try to get the meaning before you tap.</p>
      ${l.examples.map((e) => jaCard(e)).join("")}
    </section>

    <section class="card"><h2>Side by side</h2>
      ${l.contrasts
        .map(
          (c) => `<div class="contrast">
          <div class="pair"><div>${ja(c.a.ja, "big")} ${sayBtn(c.a.ja)}</div><div>${ja(c.b.ja, "big")} ${sayBtn(c.b.ja)}</div></div>
          <button class="reveal" aria-expanded="false">What's the difference?</button>
          <div class="hidden-en">
            <div class="pair en-pair"><p class="en">${esc(c.a.en)}</p><p class="en">${esc(c.b.en)}</p></div>
            <p>${rich(c.why)}</p>
          </div>
        </div>`
        )
        .join("")}
    </section>

    <section class="card" id="practice"><h2>Practice</h2>
      ${skipped ? `<p class="muted small">${skipped} exercise${skipped > 1 ? "s were" : " was"} hidden because an answer was missing its explanation.</p>` : ""}
      <div id="ex-host" data-lesson="${esc(l.id)}"></div>
    </section>

    <section class="card done-card">
      ${
        done
          ? `<p><b>In your grammar reviews.</b> ${esc(srs.stageLabel(row.stage))}${row.due ? ` · next ${friendlyDate(row.due)}` : ""}.</p>`
          : `<p>Finished reading and practicing? Marking it done adds this point to your grammar reviews. The first one comes tomorrow.</p>`
      }
      <button class="btn ${done ? "ghost" : ""}" data-action="toggle-done" data-lesson="${esc(l.id)}">${done ? "Take out of reviews" : "Mark lesson done"}</button>
    </section>
  </article>`;
}

// Exercise runner state lives on the host element.
function mountExercises(lesson) {
  const host = document.getElementById("ex-host");
  if (!host) return;
  const list = lesson.exercises.filter(exerciseOk);
  const st = { i: 0, results: [] };
  const draw = () => {
    if (st.i >= list.length) {
      const right = st.results.filter((r) => r === "right").length;
      host.innerHTML = `<div class="ex-end"><p class="big-num">${right} / ${list.length}</p>
        <p>${right === list.length ? "Clean run." : "Read the explanations on the ones that didn't land — that's where the lesson is."}</p>
        <button class="btn ghost" data-action="ex-restart">Go again</button></div>`;
      const rec = store.get("jh.course", {});
      rec[lesson.id] = { ...(rec[lesson.id] || {}), lastScore: `${right}/${list.length}`, at: new Date().toISOString() };
      store.set("jh.course", rec);
      host.querySelector("[data-action=ex-restart]").onclick = () => {
        st.i = 0;
        st.results = [];
        draw();
      };
      return;
    }
    const ex = list[st.i];
    const head = `<p class="ex-count">${st.i + 1} of ${list.length}</p>${ex.scene ? `<p class="scene">${esc(ex.scene)}</p>` : ""}`;
    const next = () => {
      st.i++;
      draw();
    };
    if (ex.type === "choice") drawChoice(host, ex, head, lesson, (v) => st.results.push(v), next);
    else if (ex.type === "build") drawBuild(host, ex, head, lesson, (v) => st.results.push(v), next);
    else drawWrite(host, ex, head, lesson, (v) => st.results.push(v), next);
  };
  draw();
}

function askBlock(lesson, ex, extra) {
  const text = [
    `Japanese study question (lesson: ${lesson.title} — ${lesson.titleEn}).`,
    ex.scene ? `Scene: ${ex.scene}` : "",
    `Sentence: ${stripMarkup(ex.prompt || ex.model || "")}`,
    ex.en ? `Meaning: ${ex.en}` : "",
    extra || "",
    `Can you explain this more? I'm still not sure why.`,
  ]
    .filter(Boolean)
    .join("\n");
  return `<button class="ask" data-ask="${esc(text)}">${ICON.ask} Ask Claude about this</button>`;
}

const VERDICT = { right: "Right", wrong: "Not this one", different: "Works, but means something else" };

function drawChoice(host, ex, head, lesson, record, next) {
  const blank = (s) => renderJa(s, S.known, S.words).replace(/＿＿|＿/, '<span class="blank">＿</span>');
  host.innerHTML = `${head}
    <div class="ex-prompt"><span class="ja big" lang="ja">${blank(ex.prompt)}</span> ${sayBtn(ex.prompt.replace(/＿+/g, ""))}</div>
    <div class="opts">${ex.options.map((o, i) => `<button class="opt" data-i="${i}" lang="ja">${renderJa(o.text, S.known, S.words)}</button>`).join("")}</div>
    <div class="ex-feedback"></div>`;
  host.querySelectorAll(".opt").forEach((b) =>
    b.addEventListener("click", () => {
      if (host.dataset.answered) return;
      host.dataset.answered = "1";
      const pick = ex.options[+b.dataset.i];
      record(pick.verdict);
      host.querySelectorAll(".opt").forEach((x) => {
        const o = ex.options[+x.dataset.i];
        x.classList.add(`v-${o.verdict}`);
        if (x === b) x.classList.add("picked");
        x.disabled = true;
      });
      const order = [pick, ...ex.options.filter((o) => o !== pick)];
      host.querySelector(".ex-feedback").innerHTML = `
        <p class="verdict v-${pick.verdict}">${VERDICT[pick.verdict]}</p>
        <p class="en">${esc(ex.en || "")}</p>
        <ul class="whys">${order
          .map((o) => `<li class="v-${o.verdict}"><span class="why-opt" lang="ja">${renderJa(o.text, S.known, S.words)}</span><span class="why-tag">${VERDICT[o.verdict]}</span><p>${rich(o.why)}</p></li>`)
          .join("")}</ul>
        <div class="row">${askBlock(lesson, ex, `I picked: ${stripMarkup(pick.text)}`)}<button class="btn" data-action="next">Next</button></div>`;
      host.querySelector("[data-action=next]").onclick = () => {
        delete host.dataset.answered;
        next();
      };
    })
  );
}

function shuffled(arr, seed) {
  const a = arr.map((v, i) => ({ v, i }));
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawBuild(host, ex, head, lesson, record, next) {
  const tiles = shuffled(ex.tiles, ex.tiles.join("").length + 7);
  const picked = [];
  const paint = () => {
    host.innerHTML = `${head}
      <p class="small muted">Tap the pieces in order. Not every piece is needed.</p>
      <div class="build-answer" aria-live="polite">${
        picked.length ? picked.map((t, k) => `<button class="tile-btn on" data-k="${k}" lang="ja">${renderJa(ex.tiles[t], S.known, S.words)}</button>`).join("") : `<span class="muted small">Your sentence…</span>`
      }</div>
      <div class="build-bank">${tiles
        .map((t) => `<button class="tile-btn" data-t="${t.i}" ${picked.includes(t.i) ? "disabled" : ""} lang="ja">${renderJa(t.v, S.known, S.words)}</button>`)
        .join("")}</div>
      <button class="reveal" aria-expanded="false">Show English</button><div class="hidden-en"><p class="en">${esc(ex.en)}</p></div>
      <div class="row"><button class="btn" data-action="check" ${picked.length ? "" : "disabled"}>Check</button></div>
      <div class="ex-feedback"></div>`;
    host.querySelectorAll(".build-bank .tile-btn").forEach((b) =>
      b.addEventListener("click", () => {
        picked.push(+b.dataset.t);
        paint();
      })
    );
    host.querySelectorAll(".build-answer .tile-btn").forEach((b) =>
      b.addEventListener("click", () => {
        picked.splice(+b.dataset.k, 1);
        paint();
      })
    );
    host.querySelector("[data-action=check]").onclick = () => {
      const mine = picked.map((t) => ex.tiles[t]).join("");
      const ok = ex.answers.some((a) => a.join("") === mine);
      record(ok ? "right" : "wrong");
      const model = ex.answers[0].join("");
      host.querySelector(".ex-feedback").innerHTML = `
        <p class="verdict v-${ok ? "right" : "wrong"}">${ok ? "Right" : "Not quite"}</p>
        <p>${ja(model, "big")} ${sayBtn(model)}</p>
        <p class="en">${esc(ex.en)}</p>
        <p>${rich(ex.why)}</p>
        <div class="row">${askBlock(lesson, { ...ex, prompt: model }, `I built: ${stripMarkup(mine)}`)}<button class="btn" data-action="next">Next</button></div>`;
      host.querySelectorAll(".tile-btn").forEach((b) => (b.disabled = true));
      host.querySelector("[data-action=check]").disabled = true;
      host.querySelector("[data-action=next]").onclick = next;
    };
  };
  paint();
}

function drawWrite(host, ex, head, lesson, record, next) {
  host.innerHTML = `${head}
    <p class="small muted">Say it out loud or type it. Then compare.</p>
    <textarea class="write" lang="ja" rows="2" placeholder="日本語で…"></textarea>
    <div class="row"><button class="btn" data-action="show">Show a model answer</button></div>
    <div class="ex-feedback"></div>`;
  host.querySelector("[data-action=show]").onclick = (e) => {
    e.target.disabled = true;
    host.querySelector(".ex-feedback").innerHTML = `
      <p>${ja(ex.model, "big")} ${sayBtn(ex.model)}</p>
      ${ex.modelPolite ? `<p class="small muted">Polite: ${ja(ex.modelPolite)}</p>` : ""}
      <p class="en">${esc(ex.en)}</p>
      <p>${rich(ex.why)}</p>
      <p class="small">How did yours compare? A different phrasing can be just as right.</p>
      <div class="row grade">
        <button class="btn ghost" data-g="right">Got it</button>
        <button class="btn ghost" data-g="different">Close</button>
        <button class="btn ghost" data-g="wrong">Not yet</button>
      </div>
      <div class="row">${askBlock(lesson, { ...ex, prompt: ex.model }, `My answer: ${host.querySelector(".write").value || "(said it out loud)"}`)}</div>`;
    host.querySelectorAll("[data-g]").forEach((b) =>
      b.addEventListener("click", () => {
        record(b.dataset.g);
        next();
      })
    );
  };
}

// ---------- grammar review session ----------

async function loadBank(id) {
  if (S.bankCache.has(id)) return S.bankCache.get(id);
  let drills = [];
  try {
    drills = (await getJSON(`data/grammar/${id}.json`)).drills || [];
  } catch {}
  drills = drills.filter(exerciseOk);
  S.bankCache.set(id, drills);
  return drills;
}

function startSession() {
  const today = todayKey();
  const due = srs.dueToday(today);
  const points = [];
  const queue = [];
  for (const row of due) {
    const drills = S.bankCache.get(row.id) || [];
    if (!drills.length) continue;
    const picked = srs.pickDrills(row, drills);
    points.push({ id: row.id, drillIds: picked.map((d) => d.id), right: 0, total: 0, result: null });
    picked.forEach((d) => queue.push({ pointId: row.id, drill: d }));
  }
  // Interleave: shuffle, then nudge apart back-to-back sentences from the same point.
  queue.sort(() => Math.random() - 0.5);
  for (let i = 1; i < queue.length; i++) {
    if (queue[i].pointId === queue[i - 1].pointId) {
      const j = queue.findIndex((q, k) => k > i && q.pointId !== queue[i].pointId);
      if (j > 0) [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }
  S.session = { date: today, points, queue, i: 0 };
}

function viewReview() {
  const today = todayKey();
  const due = srs.dueToday(today);
  const s = S.session;
  if (!s || s.date !== today) {
    if (!due.length) {
      return `<a class="back" href="#today">← Today</a><section class="card"><h1>Grammar review</h1>
        <p>Nothing due right now.${srs.nextDue(today) ? ` Next one ${friendlyDate(srs.nextDue(today))}.` : ""}</p></section>`;
    }
    const missing = due.filter((r) => !S.bankCache.has(r.id));
    if (missing.length) {
      Promise.all(missing.map((r) => loadBank(r.id))).then(() => {
        startSession();
        render();
      });
      return `<section class="card"><p class="muted">Getting your sentences…</p></section>`;
    }
    startSession();
  }
  return `<a class="back" href="#today">← Today</a>
    <section class="card review"><p class="eyebrow">Grammar review · mixed</p>
      <div id="rv-host"></div>
    </section>`;
}

function mountReview() {
  const host = document.getElementById("rv-host");
  const s = S.session;
  if (!host || !s) return;
  const draw = () => {
    if (s.i >= s.queue.length) {
      host.innerHTML = `<h2>Done.</h2>
        <ul class="rv-results">${s.points
          .map((p) => {
            const r = p.result;
            const move = !r ? "" : r.after > r.before ? "up" : r.after < r.before ? "down" : "same";
            const msg = !r
              ? "Saving…"
              : r.after >= 7
              ? "Retired — you've got this one."
              : `${move === "up" ? "Moved up" : move === "down" ? "Moved back" : "Same step"} · ${srs.stageLabel(r.after)} · next ${friendlyDate(r.due)}`;
            return `<li class="rv-${move}"><span lang="ja" class="why-opt">${esc(lessonTitle(p.id))}</span> <b>${p.right}/${p.total}</b><p class="small">${esc(msg)}</p></li>`;
          })
          .join("")}</ul>
        <p class="small muted">All right → step up. One miss → same step. More → step back. "Works, but means something else" counts as a miss — the point is choosing what you meant.</p>
        <a class="btn" href="#today">Back to Today</a>`;
      return;
    }
    const item = s.queue[s.i];
    const point = s.points.find((p) => p.id === item.pointId);
    const entry = S.lessonsIndex.find((l) => l.id === item.pointId) || { title: item.pointId, titleEn: "" };
    const head = `<div class="split"><p class="ex-count">${s.i + 1} of ${s.queue.length}</p><a class="small" href="#course/${esc(entry.id)}">Lesson ↗</a></div>
      ${item.drill.scene ? `<p class="scene">${esc(item.drill.scene)}</p>` : ""}`;
    const record = (v) => {
      point.total++;
      if (v === "right") point.right++;
      if (point.total === point.drillIds.length) {
        srs.grade(point.id, point.right, point.total, point.drillIds, s.date, S.config.syncUrl).then((r) => {
          point.result = r;
          if (s.i >= s.queue.length) draw();
        });
      }
    };
    const next = () => {
      s.i++;
      draw();
      host.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    if (item.drill.type === "build") drawBuild(host, item.drill, head, entry, record, next);
    else drawChoice(host, item.drill, head, entry, record, next);
  };
  draw();
}

// ---------- immersion ----------

const LEVEL = { 1: "Learner · slow", 2: "Learner · natural", 3: "Native · easy", 4: "Native" };
const TYPE = { listen: "Listen", watch: "Watch", read: "Read" };

function weekStartKey() {
  const today = todayKey();
  const d = new Date(today + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return srs.addDays(today, -dow);
}

function immMinutes(sinceKey) {
  return srs
    .immLog()
    .filter((r) => !sinceKey || core.localDateKey(new Date(r.updated), S.config.timeZone) >= sinceKey)
    .reduce((n, r) => n + (Number(r.right) || 0), 0);
}

function doneBtn(id, minutes, quiet = false) {
  const done = srs.immDone(id);
  return `<button class="btn ${done || quiet ? "ghost" : ""} small-btn" data-action="imm-toggle" data-id="${esc(id)}" data-min="${esc(String(minutes || 0))}">${done ? "✓ Done" : "Mark done"}</button>`;
}

function audioBtn(item) {
  return item.audio ? `<button class="btn ghost small-btn" data-action="imm-play" data-src="${esc(item.audio)}">▶ Play here</button>` : "";
}

function pickCard(p) {
  const done = srs.immDone(p.id);
  const arch = p.fromArchive ? S.imm.archive.find((a) => a.id === p.fromArchive) : null;
  const item = { ...arch, ...p, audio: p.audio || arch?.audio };
  return `<article class="pick ${done ? "is-done" : ""}">
    <p class="pick-meta"><span class="pill stage">${esc(TYPE[p.type] || "Listen")}</span> ${esc(p.source || "")}${p.minutes ? ` · ${fmt(p.minutes)} min` : ""}${p.level ? ` · ${esc(LEVEL[p.level] || "")}` : ""}</p>
    <h3><a href="${esc(p.url)}" target="_blank" rel="noopener" lang="ja">${esc(p.title)} ↗</a></h3>
    ${p.why ? `<p class="small">${rich(p.why)}</p>` : ""}
    ${p.connection ? `<p class="connect small">${rich(p.connection)}</p>` : ""}
    ${p.listenFor ? `<div class="listen-for"><p class="eyebrow">Listen for</p><p>${rich(p.listenFor)}</p></div>` : ""}
    ${p.prep?.length ? prepBlock(p.prep) : ""}
    <div class="row">${doneBtn(p.id, p.minutes)}${audioBtn(item)}</div>
    <div class="player"></div>
  </article>`;
}

function prepBlock(prep) {
  const st = prep.map((w) => ({ w, st: wordStatus(w.ja) }));
  const knownN = st.filter((x) => x.st.known).length;
  return `<div class="prep"><div class="split"><p class="eyebrow">Words to know first</p>${
    S.words.size ? `<p class="small muted">${knownN} of ${prep.length} from WaniKani</p>` : ""
  }</div>
    <div class="prep-words">${st.map(({ w, st }) => `<span class="prep-w pw-${st.cls}" title="${esc(st.label)}">${ja(w.ja)}</span>`).join("")}</div>
    <p class="small muted prep-key"><span class="key k-wk"></span>know it <span class="key k-learning"></span>learning <span class="key k-new"></span>new</p>
    <button class="reveal" aria-expanded="false">Show meanings</button>
    <div class="hidden-en"><ul class="prep-list">${st
      .map(({ w, st }) => `<li>${ja(w.ja)} ${sayBtn(w.ja)} <span class="en">${esc(w.en)}</span> <span class="wtag wt-${st.cls}">${esc(st.cls === "new" ? "New" : st.label)}</span></li>`)
      .join("")}</ul></div></div>`;
}

function archiveRow(a) {
  const done = srs.immDone(a.id);
  return `<li class="arch ${done ? "is-done" : ""}">
    <div class="arch-main">
      <a href="${esc(a.url)}" target="_blank" rel="noopener" lang="ja">${esc(a.title)}</a>
      <p class="small muted">${esc(a.sourceName || a.source || "")}${a.minutes ? ` · ${fmt(a.minutes)} min` : ""} · ${esc(LEVEL[a.level] || "")}${a.date ? ` · ${esc(shortDate(a.date.slice(0, 10)))}` : ""}</p>
      ${a.summary ? `<p class="small arch-sum" lang="ja">${esc(a.summary)}</p>` : ""}
      <div class="player"></div>
    </div>
    <div class="arch-act">${audioBtn(a)}${doneBtn(a.id, a.minutes, true)}</div>
  </li>`;
}

function viewImmerse() {
  const weeks = S.imm.picks.weeks || [];
  const current = weeks[0];
  const week = immMinutes(weekStartKey());
  const total = immMinutes(null);
  const doneCount = srs.immLog().length;
  const head = `<section class="card intro"><h1>Immerse</h1>
    <p>Five picks a week, chosen for your level and interests, with the words to know before you start. New podcast episodes arrive every night.</p>
    <div class="tiles imm-tiles">
      ${tile("This week", `${fmt(week)} min`, "listened or watched")}
      ${tile("All time", `${fmt(total)} min`, `${fmt(doneCount)} item${doneCount === 1 ? "" : "s"} done`)}
    </div>
  </section>`;

  const picks = current
    ? `<section class="card"><p class="eyebrow">This week · ${esc(friendlyDate(current.week))}</p>
        ${current.note ? `<p>${rich(current.note)}</p>` : ""}
        ${current.picks.map(pickCard).join("")}</section>`
    : `<section class="card"><h2>This week's picks</h2><p>The first five arrive Sunday evening. Until then, the new episodes below are a good place to start — the beginner Teppei episodes especially.</p></section>`;

  // Newest unfinished episode from each show, learner shows first — so one busy feed
  // (NHK news posts hourly) can't crowd out the rest.
  const perShow = new Map();
  for (const a of S.imm.archive) {
    if (srs.immDone(a.id)) continue;
    const k = a.source || a.sourceName;
    if (!perShow.has(k)) perShow.set(k, a);
  }
  const fresh = [...perShow.values()].sort((a, b) => (a.level || 9) - (b.level || 9) || (b.date || "").localeCompare(a.date || "")).slice(0, 7);
  const freshCard = fresh.length
    ? `<section class="card"><h2>New episodes</h2><p class="small muted">The latest from each show, easiest first.</p><ul class="arch-list">${fresh.map(archiveRow).join("")}</ul></section>`
    : `<section class="card"><h2>New episodes</h2><p class="muted">The nightly job starts filling this in tonight.</p></section>`;

  const q = S.immQuery.trim().toLowerCase();
  const f = S.immFilter;
  const all = S.imm.archive.concat(
    weeks.slice(1).flatMap((w) => w.picks.map((p) => ({ ...p, sourceName: p.source, date: w.week + "T12:00:00Z" })))
  );
  const hits = all.filter((a) => {
    const blob = [a.title, a.sourceName, a.source, a.summary, (a.tags || []).join(" ")].join(" ").toLowerCase();
    const lvlOk = f === "learner" ? a.level <= 2 : f === "native" ? a.level >= 3 : f === "done" ? srs.immDone(a.id) : f === "todo" ? !srs.immDone(a.id) : true;
    return (!q || blob.includes(q)) && lvlOk;
  });
  const shown = hits.slice(0, S.immShow || 30);
  const filters = [
    ["all", "All"],
    ["learner", "Learner"],
    ["native", "Native"],
    ["todo", "Not done"],
    ["done", "Done"],
  ];
  const arch = `<section class="card"><h2>Archive</h2>
    <input class="search" id="imm-search" type="search" placeholder="Search titles, shows, topics…" value="${esc(S.immQuery)}" aria-label="Search the archive">
    <div class="tag-row">${filters.map(([k, l]) => `<button class="tag ${f === k ? "on" : ""}" data-immf="${k}">${l}</button>`).join("")}</div>
    ${shown.length ? `<ul class="arch-list">${shown.map(archiveRow).join("")}</ul>` : `<p class="muted">Nothing here yet.</p>`}
    ${hits.length > shown.length ? `<button class="btn ghost" data-action="imm-more">Show more (${fmt(hits.length - shown.length)})</button>` : ""}
  </section>`;

  return head + picks + freshCard + arch;
}

// ---------- scenes ----------
// Real situations that grow with you. Each scene has tiers that open as grammar lessons are
// marked done, its own small vocabulary track, and three ways to practice out loud.

const TIERS = ["survival", "natural", "conversation", "onstage"];
const TIER_INFO = {
  survival: { label: "Survival", sub: "Works right now. Memorize it whole." },
  natural: { label: "Natural", sub: "Sounds like you, once the grammar is in." },
  conversation: { label: "Conversation", sub: "The small talk after the transaction." },
  onstage: { label: "Onstage", sub: "A short spoken piece to learn by heart." },
};

const sceneById = (id) => S.scenes.find((x) => x.id === id);
const sceneTiers = (sc) => TIERS.filter((t) => sc.tiers?.[t]).map((t) => ({ key: t, ...sc.tiers[t] }));
const sceneActive = (sc) => !sc.when || sc.when <= todayKey();

function chapterBySlug(slug) {
  for (const sec of S.curriculum.sections) for (const c of sec.chapters) if (c.slug === slug) return c;
  return null;
}

// What a tier is waiting on: lesson ids it requires, plus Tae Kim chapters that don't have a lesson yet.
function tierNeeds(tier) {
  const needs = (tier.requires || []).map((id) => ({ label: lessonTitle(id), done: isDone(id) }));
  for (const slug of tier.requiresChapters || []) {
    const c = chapterBySlug(slug);
    const label = c ? c.title.replace(/\s*\(.*\)$/, "") : slug;
    needs.push({ label, done: !!(c && c.lesson && isDone(c.lesson)), future: !(c && c.lesson) });
  }
  return needs;
}
const tierOpen = (tier) => tierNeeds(tier).every((n) => n.done);

function sceneTexts(sc) {
  return sceneTiers(sc).flatMap((t) => [...(t.dialogue || []), ...(t.phrases || [])].map((l) => l.ja)).concat((sc.vocab || []).map((v) => v.ja));
}

// ----- scene vocabulary -----

function vocInfo(id) {
  const [, sceneId, wordId] = id.split(":");
  const sc = sceneById(sceneId);
  const word = sc?.vocab?.find((v) => v.id === wordId);
  return word ? { id, sc, word } : null;
}

// Words worth reviewing here: not already in WaniKani (no reviewing the same word twice).
const vocFromWK = (word) => !!wordStatus(word.ja).v;

function vocQueue() {
  const today = todayKey();
  const due = srs.vocDue(today).map((r) => vocInfo(r.id)).filter(Boolean).slice(0, srs.VOC_PER_DAY);
  const room = Math.min(srs.VOC_NEW_PER_DAY - srs.vocNewToday(today), srs.VOC_PER_DAY - due.length);
  const fresh = [];
  if (room > 0) {
    const active = S.scenes.filter(sceneActive).sort((a, b) => (a.when || "").localeCompare(b.when || ""));
    for (const sc of active)
      for (const word of sc.vocab || []) {
        const id = srs.vocId(sc.id, word.id);
        if (fresh.length >= room) break;
        if (!srs.state.rows.get(id)?.stage && !vocFromWK(word)) fresh.push({ id, sc, word, isNew: true });
      }
  }
  return [...due, ...fresh];
}

function sceneWordsTile() {
  const rows = srs.vocRows();
  if (!rows.length) return "";
  const solid = rows.filter((r) => r.stage >= 5).length;
  return tile("Scene words", fmt(rows.length), `${fmt(srs.vocDue(todayKey()).length)} due · ${fmt(solid)} solid`);
}

function sceneTodayCard() {
  if (!S.scenes.length) return "";
  const today = todayKey();
  const q = vocQueue();
  const recent = S.scenes.filter((sc) => sc.when && sc.when <= today && sc.when >= srs.addDays(today, -14));
  const soon = S.scenes.filter((sc) => sc.when && sc.when > today && sc.when <= srs.addDays(today, 14));
  if (!q.length && !recent.length && !soon.length) return "";
  const nNew = q.filter((x) => x.isNew).length;
  return `<section class="card scene-today"><p class="eyebrow" lang="ja">場面 · Scenes</p>
    ${
      q.length
        ? `<div class="split"><p class="big-num">${q.length}</p><p class="muted small">scene word${q.length > 1 ? "s" : ""}${nNew ? ` · ${nNew} new` : ""}</p></div>
           <a class="btn" href="#scenes/words">Review words</a>`
        : ""
    }
    ${recent.map((sc) => `<p class="small">New: <a href="#scenes/${esc(sc.id)}"><span lang="ja">${esc(stripMarkup(sc.title))}</span> · ${esc(sc.titleEn)}</a></p>`).join("")}
    ${soon.map((sc) => `<p class="small muted">Coming up ${esc(friendlyDate(sc.when))}: <a href="#scenes/${esc(sc.id)}">${esc(sc.titleEn)}</a></p>`).join("")}
  </section>`;
}

// ----- list + phrasebook search -----

function viewScenes(arg) {
  if (arg === "words") return viewSceneWords();
  if (arg) return viewScene(arg);
  const q = S.sceneQuery.trim().toLowerCase();
  const head = `<section class="card intro"><h1>Scenes</h1>
    <p>Real situations from the trip. Each one opens up as your grammar grows: survival first, then more natural lines, then real conversation.</p>
    <input id="scene-search" class="search" type="search" placeholder="Search every line: Japanese or English…" value="${esc(S.sceneQuery)}" aria-label="Search scenes">
  </section>`;
  if (q) {
    const hits = [];
    for (const sc of S.scenes)
      for (const t of sceneTiers(sc))
        for (const l of [...(t.dialogue || []), ...(t.phrases || [])]) {
          const blob = [stripMarkup(l.ja), l.ja, l.en, l.note || ""].join(" ").toLowerCase();
          if (blob.includes(q)) hits.push({ sc, l });
        }
    return (
      head +
      `<section class="card">${
        hits.length
          ? hits.map((h) => `<p class="scene"><a href="#scenes/${esc(h.sc.id)}">${esc(h.sc.titleEn)}</a>${h.l.who === "them" ? " · they say" : ""}</p>${jaCard(h.l)}`).join("")
          : `<p class="muted">Nothing matches.</p>`
      }</section>`
    );
  }
  const today = todayKey();
  const sorted = [...S.scenes].sort((a, b) => {
    const aa = sceneActive(a), bb = sceneActive(b);
    if (aa !== bb) return aa ? -1 : 1;
    return aa ? 0 : (a.when || "").localeCompare(b.when || "");
  });
  const q2 = vocQueue();
  const words = q2.length
    ? `<section class="card"><div class="split"><h2>Scene words</h2><span class="big-num">${q2.length}</span></div>
        <p class="small muted">Words from your current scenes that aren't in WaniKani. At most ${srs.VOC_PER_DAY} a day.</p>
        <a class="btn" href="#scenes/words">Review words</a></section>`
    : "";
  const cards = sorted
    .map((sc) => {
      const tiers = sceneTiers(sc);
      const open = tiers.filter(tierOpen).length;
      const live = sceneActive(sc);
      return `<a class="card scene-card ${live ? "" : "later"}" href="#scenes/${esc(sc.id)}">
        <div class="split"><h2 lang="ja">${esc(stripMarkup(sc.title))}</h2><span class="small muted">${live ? "" : esc(friendlyDate(sc.when))}</span></div>
        <p class="scene-en">${esc(sc.titleEn)}</p>
        <p class="small muted">${esc(sc.situation)}</p>
        <p class="tier-dots" aria-label="${open} of ${tiers.length} tiers open">${tiers
          .map((t) => `<span class="tier-dot ${tierOpen(t) ? "on" : ""}">${esc(TIER_INFO[t.key].label)}</span>`)
          .join("")}</p>
      </a>`;
    })
    .join("");
  return head + words + cards + `<p class="muted small center">Want a new scene? Add a row to the "Scene requests" tab in your Sheet. The Sunday task writes it.</p>`;
}

// ----- one scene -----

function dlineCard(l) {
  return `<div class="dline ${l.who === "them" ? "them" : "me"}"><span class="who">${l.who === "them" ? "They say" : "You say"}</span>${jaCard(l)}</div>`;
}

function tierBody(t) {
  return `${(t.dialogue || []).map(dlineCard).join("")}
    ${t.phrases?.length ? `<h3>Also useful</h3>${t.phrases.map((p) => jaCard(p)).join("")}` : ""}`;
}

function viewScene(id) {
  const sc = sceneById(id);
  if (!sc) return `<a class="back" href="#scenes">← Scenes</a><div class="banner">No scene called ${esc(id)}.</div>`;
  const tiers = sceneTiers(sc);
  const tierCards = tiers
    .map((t) => {
      const info = TIER_INFO[t.key];
      const needs = tierNeeds(t);
      if (tierOpen(t))
        return `<section class="card tier"><div class="split"><h2>${esc(info.label)}</h2><span class="pill stage">Open</span></div>
          <p class="small muted">${esc(t.note || info.sub)}</p>${tierBody(t)}</section>`;
      return `<section class="card tier locked"><div class="split"><h2>${esc(info.label)}</h2><span class="pill ghost">Locked</span></div>
        <p class="small muted">${esc(t.note || info.sub)}</p>
        <p class="small">Opens after: ${needs
          .map((n) => `<span class="chip need ${n.done ? "done" : ""}">${n.done ? "✓ " : ""}<span lang="ja">${esc(n.label)}</span>${n.future ? " (lesson coming)" : ""}</span>`)
          .join(" ")}</p>
        <details class="peek"><summary>Peek anyway</summary>${tierBody(t)}</details></section>`;
    })
    .join("");
  const vocab = (sc.vocab || []).length
    ? `<section class="card"><h2>Words for this scene</h2>
        <ul class="voc-list">${sc.vocab
          .map((w) => {
            const st = wordStatus(w.ja);
            const row = srs.state.rows.get(srs.vocId(sc.id, w.id));
            const tag = st.v ? `<span class="chip wk">${esc(st.label)}</span>` : row?.stage ? `<span class="chip">${esc(srs.stageLabel(row.stage))}</span>` : `<span class="chip new">New</span>`;
            return `<li><span lang="ja" class="ja">${renderJa(w.ja, S.known, S.words)}</span> <span class="small">${esc(w.en)}</span> ${tag}</li>`;
          })
          .join("")}</ul>
        <p class="small muted">Words you've started in WaniKani aren't reviewed again here.${sceneActive(sc) ? "" : ` These join your scene words ${esc(friendlyDate(sc.when))}.`}</p></section>`
    : "";
  return `<a class="back" href="#scenes">← Scenes</a>
    <header class="card">
      <p class="eyebrow">Scene${sceneActive(sc) ? "" : ` · from ${esc(friendlyDate(sc.when))}`}</p>
      <h1 lang="ja" class="lesson-title">${ja(sc.title)}</h1>
      <p class="muted">${esc(sc.titleEn)}</p>
      <p class="summary">${esc(sc.situation)}</p>
      ${(sc.register || []).length ? `<ul class="register">${sc.register.map((r) => `<li class="small">${rich(r)}</li>`).join("")}</ul>` : ""}
    </header>
    <section class="card"><h2>Practice out loud</h2><div id="sp-host" data-scene="${esc(sc.id)}"></div></section>
    ${tierCards}${vocab}`;
}

// Lines you can practice: from open tiers only.
function practiceItems(sc) {
  const recall = [];
  const listen = [];
  for (const t of sceneTiers(sc).filter(tierOpen)) {
    const d = t.dialogue || [];
    d.forEach((l, i) => {
      if (l.who !== "them") recall.push({ tier: t.key, cue: d[i - 1]?.who === "them" ? d[i - 1] : null, line: l });
      else if (d[i + 1] && d[i + 1].who !== "them") listen.push({ tier: t.key, line: l, reply: d[i + 1] });
    });
    (t.phrases || []).forEach((p) => recall.push({ tier: t.key, cue: null, line: p }));
  }
  return { recall, listen };
}

function claudePrompt(sc) {
  const done = S.lessonsIndex.filter((l) => isDone(l.id)).map((l) => `${l.title} (${l.titleEn})`);
  const mine = practiceItems(sc).recall.map((x) => stripMarkup(x.line.ja)).slice(0, 10);
  return [
    `Let's role-play a short conversation in Japanese, in voice mode.`,
    `Scene: ${sc.titleEn} — ${sc.situation}`,
    `You play the other person. I'm an elementary learner${S.model ? ` (WaniKani level ${S.model.level})` : ""}: good vocabulary, weak grammar, slow listening.`,
    done.length ? `Grammar I've studied: ${done.join("; ")}.` : "",
    `Speak simple, natural polite Japanese (です/ます), in short sentences, a little slower than normal. Stay in Japanese. If I get stuck, give me a hint in simple Japanese before switching to English.`,
    `After about 8 exchanges, stop and give me gentle corrections: up to 3 things I said that could be more natural, and why.`,
    mine.length ? `Lines I've been practicing for this scene: ${mine.join(" / ")}` : "",
    `Start the conversation.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function mountScenes(arg) {
  if (!arg) {
    const input = document.getElementById("scene-search");
    input?.addEventListener("input", (e) => {
      S.sceneQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const again = document.getElementById("scene-search");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    return;
  }
  if (arg === "words") return mountSceneWords();
  const host = document.getElementById("sp-host");
  const sc = sceneById(arg);
  if (!host || !sc) return;
  const items = practiceItems(sc);
  if (!S.practice || S.practice.sceneId !== sc.id) S.practice = { sceneId: sc.id, mode: "recall", i: 0 };
  const P = S.practice;
  const tabs = () => `<div class="seg" role="tablist">
      ${[
        ["recall", "Say it"],
        ["listen", "Listen"],
        ["claude", "With Claude"],
      ]
        .map(([k, label]) => `<button role="tab" class="seg-btn ${P.mode === k ? "on" : ""}" aria-selected="${P.mode === k}" data-mode="${k}">${label}</button>`)
        .join("")}
    </div>`;
  const draw = () => {
    let body = "";
    if (P.mode === "claude") {
      const text = claudePrompt(sc);
      body = `<p class="small">Copies a role-play prompt for this scene. Paste it into Claude, then switch to voice mode and talk it through.</p>
        <button class="btn" data-ask="${esc(text)}">${ICON.ask} Copy the role-play prompt</button>
        <details class="peek"><summary>See the prompt</summary><pre class="prompt">${esc(text)}</pre></details>`;
    } else {
      const list = P.mode === "recall" ? items.recall : items.listen;
      if (!list.length) body = `<p class="muted small">${P.mode === "listen" ? "No back-and-forth lines open yet." : "Nothing open yet."}</p>`;
      else {
        const it = list[P.i % list.length];
        const count = `<p class="ex-count">${(P.i % list.length) + 1} of ${list.length} · ${esc(TIER_INFO[it.tier].label)}</p>`;
        if (P.mode === "recall") {
          body = `${count}
            ${it.cue ? `<p class="small muted">They say</p><div class="jline">${ja(it.cue.ja, "big")} ${sayBtn(it.cue.ja)}</div>` : ""}
            <p class="small muted">You want to say</p><p class="recall-en">${esc(it.line.en)}</p>
            <p class="small muted">Say it out loud first. Then check.</p>
            <button class="reveal" aria-expanded="false">Show the Japanese</button>
            <div class="hidden-en"><div class="jline">${ja(it.line.ja, "big")} ${sayBtn(it.line.ja)}</div>${it.line.note ? `<p class="note">${rich(it.line.note)}</p>` : ""}</div>
            <div class="row"><button class="btn" data-sp="next">Next</button></div>`;
        } else {
          body = `${count}
            <p class="small">Listen, then answer out loud before you look.</p>
            <div class="row"><button class="btn ghost" data-say="${esc(stripMarkup(it.line.ja))}">${ICON.sound} Play again</button></div>
            <button class="reveal" aria-expanded="false">Show what they said</button>
            <div class="hidden-en"><div class="jline">${ja(it.line.ja, "big")}</div><p class="en">${esc(it.line.en)}</p></div>
            <button class="reveal" aria-expanded="false">Show a reply</button>
            <div class="hidden-en"><div class="jline">${ja(it.reply.ja, "big")} ${sayBtn(it.reply.ja)}</div><p class="en">${esc(it.reply.en)}</p></div>
            <div class="row"><button class="btn" data-sp="next">Next</button></div>`;
        }
      }
    }
    host.innerHTML = tabs() + `<div class="sp-body">${body}</div>`;
    host.querySelectorAll("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        P.mode = b.dataset.mode;
        P.i = 0;
        draw();
        if (P.mode === "listen") playCurrent();
      })
    );
    host.querySelector("[data-sp=next]")?.addEventListener("click", () => {
      P.i++;
      draw();
      if (P.mode === "listen") playCurrent();
    });
  };
  const playCurrent = () => {
    const it = items.listen[P.i % Math.max(1, items.listen.length)];
    if (it && !speak(it.line.ja)) toast("No Japanese voice on this device.");
  };
  draw();
}

// ----- scene word reviews -----

function viewSceneWords() {
  const today = todayKey();
  if (!S.vocSession || S.vocSession.date !== today || S.vocSession.done) {
    const items = vocQueue();
    if (!items.length)
      return `<a class="back" href="#scenes">← Scenes</a><section class="card"><h1>Scene words</h1><p>Nothing due right now. New words join as scenes come up.</p></section>`;
    S.vocSession = { date: today, items, i: 0, right: 0, done: false };
  }
  return `<a class="back" href="#scenes">← Scenes</a>
    <section class="card review"><p class="eyebrow">Scene words</p><div id="voc-host"></div></section>`;
}

function mountSceneWords() {
  const host = document.getElementById("voc-host");
  const s = S.vocSession;
  if (!host || !s) return;
  const draw = () => {
    if (s.i >= s.items.length) {
      s.done = true;
      host.innerHTML = `<h2>Done.</h2><p><b>${s.right} / ${s.items.length}</b></p>
        <p class="small muted">Right → steps up (1, 3, 7, 14, 30, 90 days). Missed → steps back.</p>
        <a class="btn" href="#today">Back to Today</a>`;
      return;
    }
    const it = s.items[s.i];
    const row = srs.state.rows.get(it.id);
    const produce = !it.isNew && row && row.stage >= 3; // later steps: English → say it
    const where = `<p class="ex-count">${s.i + 1} of ${s.items.length} · <a href="#scenes/${esc(it.sc.id)}">${esc(it.sc.titleEn)}</a></p>`;
    const word = `<div class="jline">${ja(it.word.ja, "big")} ${sayBtn(it.word.ja)}</div>`;
    const meaning = `<p class="en">${esc(it.word.en)}</p>${it.word.note ? `<p class="note">${rich(it.word.note)}</p>` : ""}`;
    if (it.isNew) {
      host.innerHTML = `${where}<p><span class="pill">New word</span></p>${word}${meaning}
        <div class="row"><button class="btn" data-g="1">Got it</button></div>`;
    } else if (produce) {
      host.innerHTML = `${where}<p class="small muted">Say it in Japanese</p><p class="recall-en">${esc(it.word.en)}</p>
        <button class="reveal" aria-expanded="false">Show the Japanese</button><div class="hidden-en">${word}${it.word.note ? `<p class="note">${rich(it.word.note)}</p>` : ""}</div>
        <div class="row grade"><button class="btn ghost" data-g="1">Got it</button><button class="btn ghost" data-g="0">Missed</button></div>`;
    } else {
      host.innerHTML = `${where}${word}<p class="small muted">What does it mean?</p>
        <button class="reveal" aria-expanded="false">Show meaning</button><div class="hidden-en">${meaning}</div>
        <div class="row grade"><button class="btn ghost" data-g="1">Got it</button><button class="btn ghost" data-g="0">Missed</button></div>`;
    }
    host.querySelectorAll("[data-g]").forEach((b) =>
      b.addEventListener("click", async () => {
        const ok = b.dataset.g === "1";
        if (ok) s.right++;
        s.i++;
        draw();
        await srs.gradeVoc(it.id, ok, s.date, S.config.syncUrl);
      })
    );
  };
  draw();
}

// ---------- notes ----------

function viewNotes() {
  const rows = S.notes || [];
  const q = (S.noteQuery || "").trim().toLowerCase();
  const tag = S.noteTag || "";
  const tags = [...new Set(rows.flatMap((r) => (r.tags || "").split(/[,、]/).map((t) => t.trim()).filter(Boolean)))].sort();
  const hits = rows.filter((r) => {
    const blob = [r.japanese, r.reading, r.english, r.notes, r.tags].join(" ").toLowerCase();
    return (!q || blob.includes(q) || stripMarkup(r.japanese || "").includes(q)) && (!tag || (r.tags || "").split(/[,、]/).map((t) => t.trim()).includes(tag));
  });
  const list = hits
    .slice()
    .reverse()
    .map((r) => {
      const jaText = r.japanese || "";
      const hasNew = kanjiIn(jaText).some((k) => !S.known.has(k));
      return `<div class="jcard note-card">
        <div class="jline">${ja(jaText, "big")} ${jaText ? sayBtn(jaText) : ""}</div>
        ${r.reading && hasNew ? `<p class="reading" lang="ja">${esc(r.reading)}</p>` : ""}
        <button class="reveal" aria-expanded="false">Show English</button>
        <div class="hidden-en">
          ${r.english ? `<p class="en">${esc(r.english)}</p>` : ""}
          ${r.notes ? `<p class="note">${esc(r.notes)}</p>` : ""}
          ${askBlock({ title: "my notes", titleEn: "notes" }, { prompt: jaText, en: r.english }, r.notes ? `My note: ${r.notes}` : "")}
        </div>
        ${r.tags ? `<p class="tags">${r.tags.split(/[,、]/).map((t) => `<span class="tag">${esc(t.trim())}</span>`).join("")}</p>` : ""}
      </div>`;
    })
    .join("");
  return `<section class="card intro"><h1>Notes</h1>
    <p>Everything from your Google Sheet. Add a row there; it shows up here.</p>
    <input class="search" type="search" placeholder="Search Japanese, English, tags…" value="${esc(S.noteQuery || "")}" aria-label="Search notes">
    ${tags.length ? `<div class="tag-row"><button class="tag ${!tag ? "on" : ""}" data-tag="">All</button>${tags.map((t) => `<button class="tag ${t === tag ? "on" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
  </section>
  ${S.notesError ? `<div class="banner">${esc(S.notesError)}</div>` : ""}
  <section class="notes-list">${
    rows.length
      ? list || `<p class="muted center">Nothing matches.</p>`
      : `<div class="card"><p>Your Sheet is empty so far.</p><p class="small muted">Columns: Japanese · Reading · English · Notes · Tags. Tip: write <span lang="ja">{漢字|かんじ}</span> in the Japanese column to give a word its reading.</p></div>`
  }</section>`;
}

// ---------- settings ----------

function viewSettings() {
  const has = !!store.get("jh.token", "");
  return `<section class="card"><h1>Settings</h1>
    <h2>WaniKani token</h2>
    <p class="small">WaniKani → Settings → API Tokens. A read-only token is all the hub needs. It's saved in this browser only, so add it once on each device.</p>
    <form id="token-form" class="row">
      <input id="token-in" type="password" autocomplete="off" placeholder="${has ? "Token saved — paste to replace" : "Paste your token"}" aria-label="WaniKani API token">
      <button class="btn" type="submit">Save</button>
    </form>
    ${has ? `<button class="btn ghost" data-action="forget-token">Remove token from this device</button>` : ""}
    <h2>Grammar review sync</h2>
    <p class="small">Saves your grammar review progress to your Google Sheet, so every device shares one queue. Paste the web app URL and key from the Apps Script setup.</p>
    <form id="sync-form" class="stack">
      <input id="sync-url" type="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(srs.syncConfig(S.config.syncUrl).url)}" aria-label="Apps Script web app URL">
      <input id="sync-key" type="password" autocomplete="off" placeholder="${srs.syncConfig().key ? "Key saved — paste to replace" : "Your key"}" aria-label="Sync key">
      <div class="row"><button class="btn" type="submit">Save and test</button><span class="small">${syncNote()}</span></div>
    </form>
    <h2>Audio</h2>
    ${audioSection()}
    <h2>Data</h2>
    <div class="row">
      <button class="btn ghost" data-action="refresh">${ICON.refresh} Refresh now</button>
      <button class="btn ghost" data-action="clear-cache">Clear saved data</button>
    </div>
    <p class="small muted">WaniKani refreshes automatically when you open the hub (every ${CACHE_MIN} minutes at most). Grammar reviews sync through your Sheet once it's set up; until then they're saved on this device.</p>
    <h2>Links</h2>
    <p class="small"><a href="${esc(S.config.sheetCsv.replace(/\/pub\?output=csv$/, "/pubhtml"))}" target="_blank" rel="noopener">Published notes Sheet</a> · <a href="https://github.com/tylerkline-mus/japanese" target="_blank" rel="noopener">Repo</a> · <a href="?demo">Demo mode</a></p>
  </section>`;
}

function audioSection() {
  const names = "speechSynthesis" in window ? voiceNames() : [];
  return `<p class="small">Sentences are read by your device's own Japanese voice.</p>
    <div class="row"><button class="btn ghost" data-say-test="こんにちは。日本語の勉強をしています。">${ICON.sound} Test voice</button></div>
    <p class="small" id="voice-log" aria-live="polite"></p>
    <p class="small muted">${
      names.length
        ? `Japanese voices on this device: ${esc(names.join(", "))}. The hub uses the first one that works and remembers it.`
        : `No Japanese voice found yet (they sometimes load a second late — reopen Settings). On a Mac: System Settings → Accessibility → Spoken Content → System voice → Manage Voices → Japanese → download Kyoko. On iPhone: Settings → Accessibility → Spoken Content → Voices → Japanese. Then reload the hub.`
    }</p>`;
}

// ---------------- router ----------------

const ROUTES = { today: viewToday, stats: viewStats, course: viewCourse, scenes: viewScenes, phrases: viewScenes, notes: viewNotes, settings: viewSettings, review: viewReview, immerse: viewImmerse };

function render() {
  const [name, arg] = (location.hash.replace(/^#/, "") || "today").split("/");
  const fn = ROUTES[name] || viewToday;
  setChartWidth(Math.min(760, window.innerWidth) - 32 - 42);
  $app().innerHTML = fn(arg);
  const navName = name === "review" ? "today" : name === "phrases" ? "scenes" : ROUTES[name] ? name : "today";
  document.querySelectorAll("nav a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navName));
  setStatus();
  if (name === "course" && arg && S.lessonCache.has(arg)) mountExercises(S.lessonCache.get(arg));
  if (name === "review") mountReview();
  if (name === "scenes" || name === "phrases") mountScenes(arg);
  if (name === "immerse") {
    const input = document.getElementById("imm-search");
    input?.addEventListener("input", (e) => {
      S.immQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const again = document.getElementById("imm-search");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
  }
  if (name === "notes") {
    const input = $app().querySelector(".search");
    input?.addEventListener("input", (e) => {
      S.noteQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const again = $app().querySelector(".search");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
  }
  if (name === "settings") {
    document.getElementById("sync-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const url = document.getElementById("sync-url").value.trim();
      const key = document.getElementById("sync-key").value.trim() || srs.syncConfig().key;
      if (!url || !key) return toast("Add both the URL and the key.");
      toast("Testing…");
      try {
        await srs.testSync(url, key);
        srs.saveSyncConfig(url, key);
        await srs.load(S.config.syncUrl);
        toast("Connected. Reviews now sync through your Sheet.");
      } catch (err) {
        toast("Couldn't connect: " + (err.message || "check the URL and key"));
      }
      render();
    });
    document.getElementById("token-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = document.getElementById("token-in").value.trim();
      if (!v) return;
      try {
        await core.wkGet("/user", v);
        store.set("jh.token", v);
        toast("Token saved. Loading your WaniKani…");
        location.hash = "#today";
        await refreshWK(true);
      } catch (err) {
        toast(err.message || "That token didn't work.");
      }
    });
  }
}

function wireGlobal() {
  document.addEventListener("click", async (e) => {
    const kj = e.target.closest(".kj");
    if (kj && !kj.closest("button, a")) return showKanji(kj);
    const t = e.target.closest("button, a");
    if (!t) return hidePop();
    hidePop();
    if (t.matches(".reveal")) {
      const open = t.getAttribute("aria-expanded") === "true";
      if (!t.dataset.label) t.dataset.label = t.textContent;
      t.setAttribute("aria-expanded", String(!open));
      t.nextElementSibling?.classList.toggle("open", !open);
      t.textContent = open ? t.dataset.label : "Hide";
      return;
    }
    if (t.matches("[data-say-test]")) {
      const log = document.getElementById("voice-log");
      const lines = [];
      const report = (m) => {
        lines.push(m);
        if (log) log.textContent = lines.join(" → ");
      };
      report("Sending to the speech engine…");
      speak(t.dataset.sayTest, 0.9, report);
      return;
    }
    if (t.matches("[data-say]")) {
      if (!speak(t.dataset.say)) toast("No Japanese voice on this device.");
      return;
    }
    if (t.matches("[data-ask]")) {
      const ok = await copyText(t.dataset.ask);
      toast(ok ? "Copied — paste it to Claude." : "Couldn't copy on this browser.");
      return;
    }
    if (t.matches("[data-immf]")) {
      S.immFilter = t.dataset.immf;
      S.immShow = 30;
      return render();
    }
    if (t.matches("[data-tag]")) {
      S.noteTag = t.dataset.tag;
      return render();
    }
    const act = t.dataset.action;
    if (act === "imm-toggle") {
      const done = srs.immDone(t.dataset.id);
      await srs.setImm(t.dataset.id, Number(t.dataset.min) || 0, !done, S.config.syncUrl);
      toast(done ? "Marked not done." : `Logged${Number(t.dataset.min) ? ` ${t.dataset.min} min` : ""}. お疲れさま！`);
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      return;
    }
    if (act === "imm-play") {
      const box = t.closest(".pick, .arch")?.querySelector(".player");
      if (box && !box.querySelector("audio")) {
        box.innerHTML = `<audio controls autoplay preload="none" src="${esc(t.dataset.src)}"></audio>`;
        t.remove();
      }
      return;
    }
    if (act === "imm-more") {
      S.immShow = (S.immShow || 30) + 30;
      return render();
    }
    if (act === "toggle-done") {
      const id = t.dataset.lesson;
      const rec = store.get("jh.course", {});
      if (isDone(id)) {
        await srs.unenroll(id, S.config.syncUrl);
        rec[id] = { ...(rec[id] || {}), done: false };
        toast("Taken out of reviews.");
      } else {
        await srs.enroll(id, todayKey(), S.config.syncUrl);
        rec[id] = { ...(rec[id] || {}), done: true };
        toast("Added to grammar reviews. First one tomorrow.");
      }
      store.set("jh.course", rec);
      render();
    } else if (act === "refresh") {
      await Promise.all([loadHistory(), loadNotes()]);
      await refreshWK(true);
      toast("Refreshed.");
    } else if (act === "clear-cache") {
      store.del("jh.wk");
      store.del("jh.notes");
      S.raw = null;
      S.rawAt = null;
      S.model = null;
      toast("Cleared. Reloading…");
      await refreshWK(true);
    } else if (act === "forget-token") {
      store.del("jh.token");
      store.del("jh.wk");
      S.raw = S.model = null;
      S.rawAt = null;
      toast("Token removed from this device.");
      render();
    }
  });

  // Chart tooltips (hover on desktop, tap on phones).
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.classList.add("show");
    const w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2)) + "px";
    tip.style.top = y - 44 + window.scrollY + "px";
    document.querySelectorAll(".tip-on").forEach((n) => n.classList.remove("tip-on"));
    el.classList.add("tip-on");
  };
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el) show(el, e.clientX, e.clientY);
    else if (e.pointerType === "mouse") {
      tip.classList.remove("show");
      document.querySelectorAll(".tip-on").forEach((n) => n.classList.remove("tip-on"));
    }
  });
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el) show(el, e.clientX, e.clientY);
    else tip.classList.remove("show");
  });
}

// Kanji popover: meaning, readings, and your WaniKani stage.
function showKanji(el) {
  const ch = el.dataset.kanji;
  const word = el.dataset.word && S.words.get(el.dataset.word);
  const info = S.kanjiInfo.get(ch);
  const pop = document.getElementById("kpop") || Object.assign(document.createElement("div"), { id: "kpop", className: "kpop" });
  document.body.appendChild(pop);
  const stage = info ? S.stageBySubject.get(info.id) : null;
  const meanings = info ? info.meanings.map((m) => m.meaning).join(", ") : "";
  const on = info ? info.readings.filter((r) => r.type === "onyomi").map((r) => r.reading).join("、") : "";
  const kun = info ? info.readings.filter((r) => r.type === "kunyomi").map((r) => r.reading).join("、") : "";
  const wordHtml = word
    ? `<div class="kpop-word"><p class="kpop-w" lang="ja">${esc(el.dataset.word)}</p><p class="small"><span lang="ja">${esc(word.r)}</span> · <b>${esc(word.m)}</b></p>
       <p class="small muted">Vocab · level ${word.l} · ${stageName(word.s)}</p></div>`
    : "";
  pop.innerHTML = wordHtml + (info
    ? `<p class="kpop-ch" lang="ja">${esc(ch)}</p><p><b>${esc(meanings)}</b></p>
       ${on ? `<p class="small" lang="ja">音 ${esc(on)}</p>` : ""}${kun ? `<p class="small" lang="ja">訓 ${esc(kun)}</p>` : ""}
       <p class="small muted">Level ${info.level} · ${stageName(stage)}</p>
       <a class="small" href="${esc(info.document_url)}" target="_blank" rel="noopener">Open on WaniKani ↗</a>`
    : `<p class="kpop-ch" lang="ja">${esc(ch)}</p><p class="small muted">${S.raw ? "Not in your WaniKani levels yet." : "Connect WaniKani to see details."}</p>
       <a class="small" href="https://www.wanikani.com/kanji/${encodeURIComponent(ch)}" target="_blank" rel="noopener">Look it up ↗</a>`);
  const r = el.getBoundingClientRect();
  pop.classList.add("show");
  const w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  pop.style.top = r.bottom + window.scrollY + 8 + "px";
}
function hidePop() {
  document.getElementById("kpop")?.classList.remove("show");
}

boot().catch((e) => {
  document.getElementById("view").innerHTML = `<div class="banner">Something went wrong loading the hub: ${esc(e.message)}</div>`;
});
