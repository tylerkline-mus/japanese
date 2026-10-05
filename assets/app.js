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
  vault: { weeks: [], sentences: {} },
  warmSession: null,
  vaultQuiz: null,
  glue: { glue: [], answered: {} },
  practiceRun: null,
  selftalk: [],
  error: null,
  loading: false,
};

const $app = () => document.getElementById("view");
const todayKey = () => core.studyDayKey(new Date(), S.config.timeZone);
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
  await Promise.all([loadHistory(), loadNotes(), loadReviews(), loadImmersion(), loadVocab(), loadVault(), loadGlue()]);
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
  const liveBurn = live.srs.burned;
  // Last numbers this device saw, kept per day. If it saw them late last night, that's as good
  // as a snapshot for where today started.
  const lastSeen = raw.demo ? null : store.get("jh.last", null);
  if (!raw.demo) store.set("jh.last", { date: live.date, mc: liveMC, burned: liveBurn, at: now.toISOString() });
  const yKey = srs.addDays(live.date, -1);
  const prev = core.previousDayRow(S.history, live.date, tz);
  // Candidates for "where today started", each {mc, burned}. Late last night wins (largest);
  // otherwise the earliest reading from today.
  const night = [
    prev ? { mc: prev.meaning[0], burned: prev.srs?.burned } : null,
    lastSeen && lastSeen.date === yKey && lastSeen.at && core.isLate(lastSeen.at, tz) ? { mc: lastSeen.mc, burned: lastSeen.burned } : null,
  ].filter((b) => b && b.mc <= liveMC);
  let base = night.length ? night.reduce((a, b) => (b.mc > a.mc ? b : a)) : null;
  let baseSource = base ? "snapshot" : "device";
  if (!base && !raw.demo) {
    // No reading from last night. Use the earliest one we have for today: an earlier
    // snapshot from today (shared by every device) or this device's first look.
    const saved = store.get("jh.base", null);
    let device = saved && saved.date === live.date && saved.mc <= liveMC ? { mc: saved.mc, burned: saved.burned } : null;
    if (!device) {
      device = { mc: liveMC, burned: liveBurn };
      store.set("jh.base", { date: live.date, mc: liveMC, burned: liveBurn });
    } else if (device.burned == null) {
      device.burned = liveBurn; // saved before burns were tracked: count burns from now
      store.set("jh.base", { date: live.date, mc: device.mc, burned: liveBurn });
    }
    const todayRow = S.history.find((h) => h.date === live.date && Array.isArray(h.meaning) && h.meaning[0] <= liveMC);
    base = device;
    if (todayRow && todayRow.meaning[0] <= device.mc) {
      base = { mc: todayRow.meaning[0], burned: todayRow.srs?.burned };
      baseSource = "earlier-snapshot";
    }
  }
  if (!base) base = { mc: liveMC - 73, burned: liveBurn - 9 }; // demo only
  const done = Math.max(0, liveMC - base.mc);
  const burnedToday = base.burned == null ? null : Math.max(0, liveBurn - base.burned);
  live.reviewedToday = done;
  live.burnedToday = burnedToday;

  S.known = core.knownKanji(raw.assignments, raw.kanjiSubjects);
  S.stageBySubject = new Map(raw.assignments.map((a) => [a.data.subject_id, a.data.srs_stage]));
  S.kanjiInfo = new Map(raw.kanjiSubjects.map((k) => [k.data.characters, { ...k.data, id: k.id }]));

  const subj = new Map([...raw.kanjiSubjects, ...raw.leechSubjects].map((s) => [s.id, s]));
  const leeches = core.findLeeches(raw.stats, raw.assignments, 12).map((l) => ({ ...l, subject: subj.get(l.subject_id) || null }))
    .filter((l) => l.subject);

  // History merged with today's live numbers.
  const hist = S.history.filter((h) => h.date !== live.date).concat([live]).sort((a, b) => a.date.localeCompare(b.date));
  const weekAgoKey = core.studyDayKey(new Date(now.getTime() - 7 * 86400000), tz);
  const weekBase = [...hist].reverse().find((h) => h.date <= weekAgoKey) || (hist.length > 1 ? hist[0] : null);
  const between = weekBase && weekBase.date !== live.date ? core.accuracyBetween(weekBase, live) : null;
  const week = between ? { ...between, since: weekBase.date } : null;

  S.model = {
    username: raw.user.data.username,
    level: raw.user.data.level,
    queue: q.reviews,
    lessons: q.lessons,
    target,
    done,
    burnedToday,
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

  if (!token()) return top + practiceCard() + needToken() + grammarCard() + sceneTodayCard() + vaultTodayCard() + lessonCard() + selftalkCard();
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
    ${m.burnedToday != null ? `<p class="burn-today"><span class="flame" aria-hidden="true">🔥</span> <b>${fmt(m.burnedToday)}</b> burned today <span class="muted small">· ${fmt(m.srs.burned)} gone for good</span></p>` : ""}
    ${
      m.baseSource === "device"
        ? `<p class="muted small">Counting from when this device first opened the hub today (no late-night snapshot from yesterday).</p>`
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

  return top + errorBanner() + practiceCard() + target + grammarCard() + sceneTodayCard() + vaultTodayCard() + lessonCard() + selftalkCard() + queueCard + leech;
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
    <p class="talk-q" lang="ja">${p.q ? ja(p.q) : esc(p.en)}</p>
    <p class="small muted">Answer in your head or out loud, in Japanese. Two or three sentences.</p>
    <button class="reveal" aria-expanded="false">English / a start</button>
    <div class="hidden-en">${p.q ? `<p class="en">${esc(p.en)}</p>` : ""}<p>${ja(p.ja, "big")} ${sayBtn(p.ja)}</p></div>
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
    ${warmTile()}
  </section>`;

  const groups = core.SRS_GROUPS.map((g) => ({ key: g.key, label: g.label, value: m.srs[g.key] }));
  const srsCard = `<section class="card"><h2>Where your items are</h2>${stackBar(groups)}</section>`;

  const burnsCard = burnsChart(m);

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

  return errorBanner() + tiles + srsCard + burnsCard + burn + heat + forecastCard + accCard + grammarStats() + paceCard + coverage + leeches + table;
}

// Items burned per day: from each row's burnedToday, or the change from the previous day's row.
function burnsChart(m) {
  const pts = [];
  m.hist.forEach((h, i) => {
    let v = h.burnedToday;
    const p = m.hist[i - 1];
    if (v == null && p && p.srs && h.srs && srs.addDays(p.date, 1) === h.date) v = Math.max(0, h.srs.burned - p.srs.burned);
    if (v != null) pts.push({ label: shortDate(h.date), value: v, tip: `${h.date}: ${fmt(v)} burned`, emphasis: h === m.live });
  });
  const total = pts.reduce((n, p) => n + p.value, 0);
  return `<section class="card"><div class="split"><h2>Burned</h2><span class="big-num">${fmt(m.srs.burned)}</span></div>
    ${
      pts.length > 1
        ? barChart(pts.slice(-21), { height: 160 }) + `<p class="muted small">${fmt(total)} burned over ${pts.length} days. Each one is gone from your reviews for good.</p>`
        : `<p class="muted small">${m.burnedToday != null ? `<b>${fmt(m.burnedToday)}</b> today so far. ` : ""}The daily chart fills in from tonight's snapshot.</p>`
    }
  </section>`;
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
    .filter((r) => !sinceKey || core.studyDayKey(new Date(r.updated), S.config.timeZone) >= sinceKey)
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

function viewScenes(arg, arg2) {
  if (arg === "glue") return viewGlue(arg2);
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
  const glueCard = `<a class="card scene-card glue-card" href="#scenes/glue"><div class="split"><h2 lang="ja">つなぎ言葉</h2><span class="small muted">${(S.glue.glue || []).length} words</span></div>
      <p class="scene-en">Glue</p><p class="small muted">えっと, だけど, そうなんだ, やっぱり… the small words that make it sound like talking.</p></a>`;
  return head + words + glueCard + cards + `<p class="muted small center">Want a new scene? Add a row to the "Scene requests" tab in your Sheet. The Sunday task writes it.</p>`;
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
    (() => {
      const g = (S.glue.glue || []).filter((e) => srs.state.rows.get("glu:" + e.id)?.stage).map((e) => e.ja.replace(/\{([^|{}]+)\|[^{}]+\}/g, "$1"));
      return `Talk the way people really talk, with natural fillers and reactions (えっと, そうなんですね, じゃあ, やっぱり…).${g.length ? ` Glue words I'm practicing: ${g.join("、")}. Use them, and nudge me to use them too.` : ""}`;
    })(),
    `After about 8 exchanges, stop and give me gentle corrections: up to 3 things I said that could be more natural, and why. If I sounded stiff or textbook-like, show how a native speaker would say it.`,
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
  if (arg === "glue") {
    document.getElementById("heard-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const what = document.getElementById("heard-what").value.trim();
      const where = document.getElementById("heard-where").value.trim();
      if (!what) return;
      await srs.addHeard(what, where, S.config.syncUrl);
      toast("Saved. The Sunday task will explain it.");
      render();
    });
    return;
  }
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

// ---------- vault ----------
// Words you've already learned on WaniKani (Guru and up), kept alive: weekly readings written
// from them, quick quizzes built on the spot, and a slow refresh cycle for burned words.

const VAULT_TIERS = [
  { key: "burned", label: "Burned", ja: "焼", test: (s) => s === 9 },
  { key: "enlightened", label: "Enlightened", ja: "悟", test: (s) => s === 8 },
  { key: "master", label: "Master", ja: "達", test: (s) => s === 7 },
  { key: "guru", label: "Guru", ja: "師", test: (s) => s === 5 || s === 6 },
];
const tierOf = (s) => VAULT_TIERS.find((t) => t.test(s))?.key || null;
const tierLabel = (k) => VAULT_TIERS.find((t) => t.key === k)?.label || k;

function vaultTiers() {
  const t = store.get("jh.vault.tiers", null);
  return new Set(Array.isArray(t) && t.length ? t : ["burned"]);
}
const allWords = () => [...S.words.entries()].map(([w, v]) => ({ ...v, w }));
const vaultWords = (tiers = vaultTiers()) => allWords().filter((x) => tiers.has(tierOf(x.s)));
const burnedWords = () => vaultWords(new Set(["burned"]));

async function loadVault() {
  const out = { weeks: [], sentences: {} };
  for (const [path, key] of [
    ["data/vault/readings.json", "weeks"],
    ["data/vault/sentences.json", "sentences"],
  ]) {
    for (const url of [rawUrl(path) + "?t=" + Date.now(), path]) {
      try {
        const d = await getJSON(url);
        out[key] = key === "weeks" ? d.weeks || [] : d.words || {};
        break;
      } catch {}
    }
  }
  S.vault = out;
}

const allReadings = () => (S.vault?.weeks || []).flatMap((w) => (w.readings || []).map((r) => ({ ...r, week: w.week })));

// Daily limit counts warm-up cards only (quizzes and readings keep words warm without using it up).
function warmCountToday() {
  const c = store.get("jh.warm.count", null);
  return c && c.date === todayKey() ? c.n : 0;
}
function bumpWarmCount() {
  store.set("jh.warm.count", { date: todayKey(), n: warmCountToday() + 1 });
}
function warmQueue() {
  return srs.warmDue(burnedWords(), todayKey(), srs.WARM_PER_DAY - warmCountToday(), (x) => (S.vault?.sentences?.[x.w]?.length ? 1 : 0));
}

function vaultTodayCard() {
  const burned = burnedWords();
  if (!burned.length) return "";
  const q = warmQueue();
  const st = srs.warmStats(burned, todayKey());
  if (!q.length && st.warm === st.total) return "";
  return `<section class="card vault-today"><p class="eyebrow" lang="ja">蔵 · Vault</p>
    ${
      q.length
        ? `<div class="split"><p class="big-num">${q.length}</p><p class="muted small">burned word${q.length > 1 ? "s" : ""} to keep warm</p></div>
           <a class="btn" href="#vault/warm">Warm them up</a>`
        : `<p><b>Done for today.</b></p>`
    }
    <p class="small muted">${fmt(st.warm)} of ${fmt(st.total)} burned words seen in the last 90 days.</p>
  </section>`;
}

function warmTile() {
  const burned = burnedWords();
  if (!burned.length) return "";
  const st = srs.warmStats(burned, todayKey());
  return tile("Burns kept warm", `${fmt(st.warm)} / ${fmt(st.total)}`, "burned words seen in 90 days");
}

function viewVault(arg, arg2) {
  if (arg === "warm") return viewWarm();
  if (arg === "quiz") return viewVaultQuiz();
  if (arg === "r" && arg2) return viewReading(arg2);
  if (!S.words.size) return `<section class="card"><p class="muted">Loading your WaniKani words…</p></section>`;
  const tiers = vaultTiers();
  const words = vaultWords(tiers);
  const counts = Object.fromEntries(VAULT_TIERS.map((t) => [t.key, allWords().filter((x) => tierOf(x.s) === t.key).length]));
  const chips = `<div class="vtiers" role="group" aria-label="Tiers">${VAULT_TIERS.map(
    (t) => `<button class="vtier ${tiers.has(t.key) ? "on" : ""}" data-vtier="${t.key}" aria-pressed="${tiers.has(t.key)}">
      <span>${esc(t.label)}</span><small>${fmt(counts[t.key])}</small></button>`
  ).join("")}</div>`;

  const burned = burnedWords();
  const st = srs.warmStats(burned, todayKey());
  const q = warmQueue();
  const warm = burned.length
    ? `<section class="card"><div class="split"><h2>Keep burns warm</h2><span class="big-num">${q.length}</span></div>
        ${meter(st.warm, Math.max(1, st.total))}
        <p class="small muted">${fmt(st.warm)} of ${fmt(st.total)} burned words seen in the last 90 days. Each one comes back about every 75 days, in a sentence when there is one. Up to ${srs.WARM_PER_DAY} a day.</p>
        ${q.length ? `<a class="btn" href="#vault/warm">Warm up ${q.length}</a>` : `<p class="small"><b>Done for today.</b></p>`}
      </section>`
    : "";

  const quiz = `<section class="card"><h2>Quick quiz</h2>
      <p class="small muted">Ten questions from your ${[...tiers].map(tierLabel).join(" + ")} words: meanings, readings, and look-alikes that share a kanji. Built fresh every time.</p>
      ${words.length >= 4 ? `<a class="btn" href="#vault/quiz" data-action="vault-quiz">Start a quiz</a>` : `<p class="small">Pick a tier with at least 4 words.</p>`}
    </section>`;

  const rs = allReadings().filter((r) => (r.tiers || []).some((t) => tiers.has(t)));
  const other = allReadings().length - rs.length;
  const readings = `<section class="card"><h2>Readings</h2>
      ${
        rs.length
          ? `<ul class="vreadings">${rs
              .map(
                (r) => `<li><a href="#vault/r/${esc(r.id)}"><span lang="ja" class="vr-title">${esc(stripMarkup(r.title))}</span>
                  <span class="small">${esc(r.titleEn)} · ${esc(r.kind || "")}</span>
                  <span class="small muted">${(r.tiers || []).map(tierLabel).join(", ")}${srs.flag("vr:" + r.id) ? " · ✓ read" : ""}</span></a></li>`
              )
              .join("")}</ul>`
          : `<p class="small muted">No readings for these tiers yet.</p>`
      }
      ${other ? `<p class="small muted">${other} more for other tiers.</p>` : ""}
      <p class="small muted">New readings arrive with the Sunday lesson.</p>
    </section>`;

  const list = `<details class="card vwords"><summary>All ${fmt(words.length)} words in these tiers</summary>
      <ul class="voc-list">${words
        .sort((a, b) => a.l - b.l || a.w.localeCompare(b.w))
        .map((x) => {
          const r = x.s === 9 ? srs.warmRow(x.w) : null;
          const tag = x.s === 9 ? (r?.seen ? `<span class="chip ${r.wrong ? "new" : "wk"}">seen ${esc(shortDate(r.seen))}</span>` : `<span class="chip">not yet</span>`) : `<span class="chip">${esc(tierLabel(tierOf(x.s)))}</span>`;
          return `<li><span lang="ja" class="ja">${esc(x.w)}</span> <span class="small" lang="ja">${esc(x.r || "")}</span> <span class="small">${esc(x.m)}</span> ${tag}</li>`;
        })
        .join("")}</ul></details>`;

  return `<section class="card intro"><h1>Vault</h1>
      <p>Words you already know from WaniKani, kept alive. Pick the tiers to work with.</p>${chips}</section>
    ${warm}${quiz}${readings}${list}`;
}

// ----- keep burns warm -----

function warmSentence(w) {
  const list = S.vault?.sentences?.[w] || [];
  if (!list.length) return null;
  const r = srs.warmRow(w);
  return list[((r?.right || 0) + (r?.wrong || 0)) % list.length];
}

function jaMarked(text) {
  const m = String(text).match(/^(.*)«(.+)»(.*)$/);
  if (!m) return ja(text, "big");
  return `<span class="ja big" lang="ja">${renderJa(m[1], S.known, S.words)}<mark>${renderJa(m[2], S.known, S.words)}</mark>${renderJa(m[3], S.known, S.words)}</span>`;
}

function viewWarm() {
  const today = todayKey();
  if (!S.warmSession || S.warmSession.date !== today || S.warmSession.done) {
    const items = warmQueue();
    if (!items.length) return `<a class="back" href="#vault">← Vault</a><section class="card"><h1>Keep burns warm</h1><p>Nothing more today. Back tomorrow.</p></section>`;
    S.warmSession = { date: today, items, i: 0, right: 0, missed: [], done: false };
  }
  return `<a class="back" href="#vault">← Vault</a><section class="card review"><p class="eyebrow">Keep burns warm</p><div id="warm-host"></div></section>`;
}

function mountWarm() {
  const host = document.getElementById("warm-host");
  const s = S.warmSession;
  if (!host || !s) return;
  const draw = () => {
    if (s.i >= s.items.length) {
      s.done = true;
      host.innerHTML = `<h2>Done.</h2><p><b>${s.right} / ${s.items.length}</b> still solid.</p>
        ${
          s.missed.length
            ? `<p class="small">Coming back in a week: ${s.missed.map((x) => `<span lang="ja" class="chip">${esc(x.w)}</span>`).join(" ")}</p>
               <p class="small muted">If one keeps slipping, you can resurrect it on WaniKani to put it back in rotation there.</p>`
            : ""
        }
        <a class="btn" href="#vault">Back to the Vault</a>`;
      return;
    }
    const x = s.items[s.i];
    const sent = warmSentence(x.w);
    const r = srs.warmRow(x.w);
    const answer = `<div class="warm-answer"><p><span lang="ja" class="ja big">${esc(x.w)}</span> <span lang="ja">${esc(x.r || "")}</span> ${sayBtn(x.w)}</p>
        <p class="en"><b>${esc(x.m)}</b></p>${sent ? `<p class="small">${esc(sent.en)}</p>` : ""}
        ${r?.wrong >= 2 ? `<p class="small"><a href="https://www.wanikani.com/vocabulary/${encodeURIComponent(x.w)}" target="_blank" rel="noopener">This one keeps slipping. Resurrect on WaniKani ↗</a></p>` : ""}</div>`;
    host.innerHTML = `<p class="ex-count">${s.i + 1} of ${s.items.length}</p>
      ${sent ? `<div class="jline">${jaMarked(sent.ja)} ${sayBtn(sent.ja.replace(/[«»]/g, ""))}</div><p class="small muted">What does the highlighted word mean? How is it read?</p>` : `<div class="jline"><span lang="ja" class="ja big">${esc(x.w)}</span></div><p class="small muted">Meaning and reading?</p>`}
      <button class="reveal" aria-expanded="false">Check</button><div class="hidden-en">${answer}</div>
      <div class="row grade"><button class="btn ghost" data-g="1">Got it</button><button class="btn ghost" data-g="0">Missed</button></div>`;
    host.querySelectorAll("[data-g]").forEach((b) =>
      b.addEventListener("click", async () => {
        const ok = b.dataset.g === "1";
        if (ok) s.right++;
        else s.missed.push(x);
        s.i++;
        bumpWarmCount();
        draw();
        await srs.gradeWarm(x.w, ok, s.date, S.config.syncUrl);
      })
    );
  };
  draw();
}

// ----- quick quiz -----

const shuffle = (arr) =>
  arr
    .map((v) => ({ v, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.v);
const sharedKanji = (a, b) => [...a.w].filter((ch) => /[一-龯々]/.test(ch) && b.w.includes(ch));
const hasKanji = (x) => /[一-龯]/.test(x.w);

function pickDistractors(t, pool, key, k = 3) {
  const norm = (v) => String(v || "").toLowerCase().trim();
  const seen = new Set([norm(t[key])]);
  const out = [];
  const near = shuffle(pool.filter((x) => x.w !== t.w && sharedKanji(t, x).length));
  const close = shuffle(pool.filter((x) => x.w !== t.w && Math.abs((x.l || 0) - (t.l || 0)) <= 2));
  for (const x of [...near, ...close, ...shuffle(pool)]) {
    if (out.length >= k) break;
    const v = norm(x[key]);
    if (!v || seen.has(v) || x.w === t.w) continue;
    seen.add(v);
    out.push(x);
  }
  return out;
}

function lookalikeNote(t, x) {
  const sh = sharedKanji(t, x);
  return sh.length ? ` It shares ${sh.join("")} with ${t.w}, which is what makes it a trap.` : "";
}

function makeQuestion(t, pool, i) {
  const types = hasKanji(t) && t.r ? ["meaning", "reading", "word"] : ["meaning", "word"];
  const type = types[i % types.length];
  if (type === "reading") {
    const ds = pickDistractors(t, pool.filter(hasKanji), "r");
    return {
      t,
      type,
      ask: "How is this read?",
      promptJa: t.w,
      options: shuffle([t, ...ds]).map((x) => ({
        text: x.r,
        ja: true,
        verdict: x === t ? "right" : "wrong",
        why: x === t ? `${t.w} is read ${t.r}: ${t.m}.` : `${x.r} is how you read ${x.w} (${x.m}).${lookalikeNote(t, x)}`,
      })),
    };
  }
  if (type === "word") {
    const ds = pickDistractors(t, pool, "w");
    return {
      t,
      type,
      ask: "Which word means this?",
      promptEn: t.m,
      options: shuffle([t, ...ds]).map((x) => ({
        text: x.w,
        ja: true,
        verdict: x === t ? "right" : "wrong",
        why: x === t ? `${t.w} (${t.r}) means ${t.m}.` : `${x.w} (${x.r}) means ${x.m}.${lookalikeNote(t, x)}`,
      })),
    };
  }
  const ds = pickDistractors(t, pool, "m");
  return {
    t,
    type: "meaning",
    ask: "What does this mean?",
    promptJa: t.w,
    options: shuffle([t, ...ds]).map((x) => ({
      text: x.m,
      verdict: x === t ? "right" : "wrong",
      why: x === t ? `${t.w} (${t.r}) means ${t.m}.` : `That's ${x.w} (${x.r}).${lookalikeNote(t, x)}`,
    })),
  };
}

function buildVaultQuiz() {
  const tiers = vaultTiers();
  const words = vaultWords(tiers);
  const pool = allWords().filter((x) => x.s >= 1);
  const picks = shuffle(words).slice(0, 10);
  return { tiers: [...tiers], qs: picks.map((t, i) => makeQuestion(t, pool, i)), i: 0, right: 0, missed: [], done: false };
}

function viewVaultQuiz() {
  if (!S.words.size) return `<section class="card"><p class="muted">Loading your WaniKani words…</p></section>`;
  if (!S.vaultQuiz || S.vaultQuiz.done) S.vaultQuiz = buildVaultQuiz();
  return `<a class="back" href="#vault">← Vault</a><section class="card review"><p class="eyebrow">Quick quiz · ${esc(S.vaultQuiz.tiers.map(tierLabel).join(" + "))}</p><div id="vq-host"></div></section>`;
}

function mountVaultQuiz() {
  const host = document.getElementById("vq-host");
  const s = S.vaultQuiz;
  if (!host || !s) return;
  const draw = () => {
    if (s.i >= s.qs.length) {
      s.done = true;
      host.innerHTML = `<h2>${s.right} / ${s.qs.length}</h2>
        ${s.missed.length ? `<p class="small">Worth another look: ${s.missed.map((x) => `<span lang="ja" class="chip">${esc(x.w)}</span>`).join(" ")}</p>` : `<p>Clean run.</p>`}
        <div class="row"><a class="btn" href="#vault/quiz" data-action="vault-quiz">Another round</a><a class="btn ghost" href="#vault">Back to the Vault</a></div>`;
      return;
    }
    const q = s.qs[s.i];
    const prompt = q.promptJa
      ? `<div class="ex-prompt"><span class="ja big" lang="ja">${esc(q.promptJa)}</span> ${sayBtn(q.promptJa)}</div>`
      : `<div class="ex-prompt"><span class="big vq-en">${esc(q.promptEn)}</span></div>`;
    host.innerHTML = `<p class="ex-count">${s.i + 1} of ${s.qs.length} · ${esc(tierLabel(tierOf(q.t.s)))}</p>
      <p class="scene">${esc(q.ask)}</p>${prompt}
      <div class="opts">${q.options.map((o, k) => `<button class="opt" data-k="${k}" ${o.ja ? 'lang="ja"' : ""}>${esc(o.text)}</button>`).join("")}</div>
      <div class="ex-feedback"></div>`;
    host.querySelectorAll(".opt").forEach((b) =>
      b.addEventListener("click", () => {
        if (host.dataset.answered) return;
        host.dataset.answered = "1";
        const pick = q.options[+b.dataset.k];
        const ok = pick.verdict === "right";
        if (ok) s.right++;
        else s.missed.push(q.t);
        if (q.t.s === 9) srs.gradeWarm(q.t.w, ok, todayKey(), S.config.syncUrl);
        host.querySelectorAll(".opt").forEach((x) => {
          const o = q.options[+x.dataset.k];
          x.classList.add(`v-${o.verdict}`);
          if (x === b) x.classList.add("picked");
          x.disabled = true;
        });
        const order = [pick, ...q.options.filter((o) => o !== pick)];
        host.querySelector(".ex-feedback").innerHTML = `
          <p class="verdict v-${pick.verdict}">${ok ? "Right" : "Not this one"}</p>
          <ul class="whys">${order.map((o) => `<li class="v-${o.verdict}"><span class="why-opt" ${o.ja ? 'lang="ja"' : ""}>${esc(o.text)}</span><span class="why-tag">${o.verdict === "right" ? "Right" : "Not this one"}</span><p>${esc(o.why)}</p></li>`).join("")}</ul>
          <div class="row"><button class="btn" data-action="vq-next">Next</button></div>`;
        host.querySelector("[data-action=vq-next]").onclick = () => {
          delete host.dataset.answered;
          s.i++;
          draw();
        };
      })
    );
  };
  draw();
}

// ----- readings -----

function viewReading(id) {
  const r = allReadings().find((x) => x.id === id);
  if (!r) return `<a class="back" href="#vault">← Vault</a><div class="banner">No reading called ${esc(id)}.</div>`;
  const plain = r.paragraphs.map((p) => stripMarkup(p.ja)).join("");
  const found = new Map();
  for (const h of findWords(plain, S.words)) if (h.info.s >= 5) found.set(h.word, h.info);
  const done = srs.flag("vr:" + r.id);
  return `<a class="back" href="#vault">← Vault</a>
    <article class="lesson">
      <header class="card"><p class="eyebrow">${esc(r.kind || "Reading")} · ${(r.tiers || []).map(tierLabel).join(", ")}</p>
        <h1 lang="ja" class="lesson-title">${ja(r.title)}</h1><p class="muted">${esc(r.titleEn)}</p>
        <p class="small muted">Read it through once for the gist, then again slowly. Tap a paragraph's English only when you're stuck.</p></header>
      <section class="card reading">${r.paragraphs
        .map((p) => `<div class="rpara"><div class="jline">${ja(p.ja, "big")} ${sayBtn(p.ja)}</div><button class="reveal" aria-expanded="false">English</button><div class="hidden-en"><p class="en">${esc(p.en)}</p></div></div>`)
        .join("")}</section>
      <section class="card"><h2>Questions</h2><div id="ex-host" data-reading="${esc(r.id)}"></div></section>
      ${
        found.size
          ? `<section class="card"><h2>Your words in this reading</h2><ul class="voc-list">${[...found.entries()]
              .map(([w, v]) => `<li><span lang="ja" class="ja">${esc(w)}</span> <span class="small" lang="ja">${esc(v.r || "")}</span> <span class="small">${esc(v.m)}</span> <span class="chip">${esc(tierLabel(tierOf(v.s)) || "")}</span></li>`)
              .join("")}</ul></section>`
          : ""
      }
      <section class="card done-card">
        <p>${done ? "<b>Read.</b> Its burned words count as kept warm." : "Finished? Marking it read counts its burned words as kept warm."}</p>
        <button class="btn ${done ? "ghost" : ""}" data-action="reading-done" data-id="${esc(r.id)}">${done ? "✓ Read" : "Mark as read"}</button>
      </section>
    </article>`;
}

function mountReading(id) {
  const r = allReadings().find((x) => x.id === id);
  if (!r) return;
  mountExercises({ id: "vr:" + r.id, title: stripMarkup(r.title), titleEn: r.titleEn, exercises: r.questions || [] });
}

async function markReadingDone(id) {
  const r = allReadings().find((x) => x.id === id);
  if (!r) return;
  const today = todayKey();
  if (srs.flag("vr:" + id)) {
    await srs.setFlag("vr:" + id, false, S.config.syncUrl);
    toast("Marked unread.");
    return;
  }
  await srs.setFlag("vr:" + id, true, S.config.syncUrl);
  const plain = r.paragraphs.map((p) => stripMarkup(p.ja)).join("");
  const burned = [...new Set(findWords(plain, S.words).filter((h) => h.info.s === 9).map((h) => h.word))];
  const n = await srs.markWarm(burned, today, S.config.syncUrl);
  toast(n ? `Read. ${n} burned word${n > 1 ? "s" : ""} kept warm.` : "Read.");
}

// ---------- glue ----------
// The small spoken words that hold conversation together: fillers, listening sounds, linkers,
// softeners, reactions. Each one is practiced, not just listed: fill-the-gap in real lines,
// then say one of your own.

const GLUE_FAMILIES = [
  { key: "filler", ja: "つなぎ", label: "Buying time" },
  { key: "listen", ja: "あいづち", label: "Listening sounds" },
  { key: "link", ja: "つなぐ", label: "Linkers" },
  { key: "soft", ja: "やわらげる", label: "Softeners & endings" },
  { key: "react", ja: "リアクション", label: "Reactions" },
];
const REGISTER = { casual: "Casual", polite: "Polite", both: "Polite or casual" };
const GLUE_NEW_PER_DAY = 3;
const GLUE_PER_DAY = 8;
const glueId = (e) => "glu:" + e.id;
const glueById = (id) => (S.glue.glue || []).find((g) => g.id === id);
const glueBare = (e) => e.ja.split(" / ")[0].replace(/[〜…？]/g, "").replace(/\{([^|{}]+)\|[^{}]+\}/g, "$1");

async function loadGlue() {
  for (const url of [rawUrl("data/glue.json") + "?t=" + Date.now(), "data/glue.json"]) {
    try {
      S.glue = await getJSON(url);
      return;
    } catch {}
  }
}

function glueQueue(onlyGlue = false) {
  const today = todayKey();
  const cap = onlyGlue ? 10 : GLUE_PER_DAY;
  const due = srs.dueWith("glu:", today).map((r) => glueById(r.id.slice(4))).filter(Boolean).slice(0, cap);
  const room = Math.min(GLUE_NEW_PER_DAY - srs.newTodayWith("glu:", today), cap - due.length);
  const fresh = room > 0 ? (S.glue.glue || []).filter((e) => !srs.state.rows.get(glueId(e))?.stage).slice(0, room) : [];
  return { due, fresh };
}

function glueStatus(e) {
  const r = srs.state.rows.get(glueId(e));
  if (!r?.stage) return `<span class="chip new">New</span>`;
  return `<span class="chip ${r.stage >= 5 ? "wk" : ""}">${esc(srs.stageLabel(r.stage).replace(" of 6", ""))}</span>`;
}

function viewGlue(id) {
  if (id) return viewGlueEntry(id);
  const all = S.glue.glue || [];
  const learned = all.filter((e) => srs.state.rows.get(glueId(e))?.stage).length;
  const answered = S.glue.answered || {};
  const heard = srs.heardList();
  const q = glueQueue(true);
  return `<a class="back" href="#scenes">← Scenes</a>
    <section class="card intro"><h1 lang="ja">つなぎ言葉</h1>
      <p><b>Glue.</b> The small words that make Japanese sound like talking: えっと, だけど, そうなんだ, やっぱり. You practice them in real lines and then use them yourself, a few new ones a day.</p></section>
    <section class="card"><div class="split"><h2>Practice</h2><span class="big-num">${q.due.length + q.fresh.length}</span></div>
      <p class="small muted">${learned} of ${all.length} in rotation · ${q.fresh.length} new today. They're also part of Daily practice on Today.</p>
      ${q.due.length + q.fresh.length ? `<a class="btn" href="#practice/glue" data-action="practice-start">Practice glue</a>` : `<p class="small"><b>Done for today.</b></p>`}
    </section>
    <section class="card"><h2>Heard something?</h2>
      <p class="small muted">A word or phrase you keep hearing and can't place. Write it however you can: kana, romaji, half a guess. The Sunday task explains it and adds it here.</p>
      <form id="heard-form" class="stack">
        <input id="heard-what" lang="ja" autocomplete="off" placeholder="e.g. なんか / \"yappa\" / sounded like 'souka'" aria-label="What you heard">
        <input id="heard-where" autocomplete="off" placeholder="Where (optional): Midnight Diner ep 3, a song, the train…" aria-label="Where you heard it">
        <div class="row"><button class="btn" type="submit">Save it</button></div>
      </form>
      ${
        heard.length
          ? `<ul class="heard-list">${heard
              .map((h) => {
                const a = answered[h.id];
                return `<li><p><b lang="ja">${esc(h.what)}</b>${h.where ? ` <span class="small muted">· ${esc(h.where)}</span>` : ""}</p>
                  ${
                    a
                      ? `<p class="small">${rich(a.answer || "")}${a.glue ? ` <a href="#scenes/glue/${esc(a.glue)}">Open →</a>` : ""}</p>`
                      : `<p class="small muted">Waiting for Sunday. <button class="linkish" data-action="heard-remove" data-id="${esc(h.id)}">Remove</button></p>`
                  }</li>`;
              })
              .join("")}</ul>`
          : ""
      }
    </section>
    ${GLUE_FAMILIES.map(
      (f) => `<section class="card"><h2><span lang="ja">${esc(f.ja)}</span> · ${esc(f.label)}</h2>
        <ul class="glue-list">${all
          .filter((e) => e.family === f.key)
          .map((e) => `<li><a href="#scenes/glue/${esc(e.id)}"><span lang="ja" class="glue-ja">${renderJa(e.ja, S.known, S.words)}</span><span class="small">${esc(e.does)}</span></a>${glueStatus(e)}</li>`)
          .join("")}</ul></section>`
    ).join("")}`;
}

function glueExampleCard(x) {
  return `<div class="jcard"><div class="jline">${jaMarked(x.ja)} ${sayBtn(x.ja.replace(/[«»]/g, ""))}</div>
    <button class="reveal" aria-expanded="false">Show English</button><div class="hidden-en"><p class="en">${esc(x.en)}</p></div></div>`;
}

function viewGlueEntry(id) {
  const e = glueById(id);
  if (!e) return `<a class="back" href="#scenes/glue">← Glue</a><div class="banner">No entry called ${esc(id)}.</div>`;
  const fam = GLUE_FAMILIES.find((f) => f.key === e.family);
  return `<a class="back" href="#scenes/glue">← Glue</a>
    <header class="card"><p class="eyebrow">${esc(fam?.label || "")} · ${esc(REGISTER[e.register] || "")}</p>
      <h1 lang="ja" class="lesson-title">${ja(e.ja)}</h1>
      <p class="summary">${esc(e.does)}</p>
      ${e.note ? `<p>${rich(e.note)}</p>` : ""}
      <p class="small muted">Where you'll hear it: ${esc(e.listen)}</p>${glueStatus(e)}</header>
    <section class="card"><h2>In real lines</h2>${e.examples.map(glueExampleCard).join("")}</section>`;
}

// ---------- daily practice ----------
// One session that pulls together everything due, Japanese-first, ending with something you say
// yourself. Each item grades into its own review track.

function dailyItems(onlyGlue) {
  const today = todayKey();
  const items = [];
  const g = glueQueue(onlyGlue);
  for (const e of g.fresh) items.push({ kind: "glue-new", e });
  const glueLater = [...g.fresh.map((e) => ({ e, fresh: true })), ...g.due.map((e) => ({ e }))];
  for (const x of glueLater) {
    const st = srs.state.rows.get(glueId(x.e))?.stage || 0;
    items.push({ kind: !x.fresh && st >= 3 && st % 2 === 1 ? "glue-say" : "glue-gap", e: x.e, fresh: x.fresh });
  }
  if (!onlyGlue) {
    for (const v of vocQueue().filter((v) => !v.isNew).slice(0, 5)) items.push({ kind: "scene-word", v });
    for (const x of warmQueue().slice(0, 4)) items.push({ kind: "warm", x });
    const listen = S.scenes.filter(sceneActive).flatMap((sc) => practiceItems(sc).listen.map((it) => ({ sc, it })));
    if (listen.length) items.push({ kind: "listen", ...listen[dayOfYear() % listen.length] });
  }
  // Interleave: new glue intros stay early; everything else shuffled, keeping a glue word's gap
  // after its own intro.
  const intros = items.filter((i) => i.kind === "glue-new");
  const rest = shuffle(items.filter((i) => i.kind !== "glue-new"));
  const ordered = [...intros.slice(0, 1), ...rest];
  intros.slice(1).forEach((it, k) => ordered.splice(Math.min(ordered.length, 2 + k * 3), 0, it));
  // Make sure each fresh gap comes after its intro.
  for (const it of ordered.filter((i) => i.kind === "glue-gap" && i.fresh)) {
    const gi = ordered.indexOf(it);
    const ii = ordered.findIndex((x) => x.kind === "glue-new" && x.e === it.e);
    if (ii > gi) {
      ordered.splice(gi, 1);
      ordered.splice(ii, 0, it);
    }
  }
  if (ordered.length) ordered.push({ kind: "talk" });
  return ordered;
}

function practiceCard() {
  if (!S.glue.glue) return "";
  const n = dailyItems(false).length;
  if (!n) return `<section class="card practice-card"><p class="eyebrow" lang="ja">今日の練習 · Daily practice</p><p><b>All done today.</b> お疲れさま！</p></section>`;
  return `<section class="card practice-card"><p class="eyebrow" lang="ja">今日の練習 · Daily practice</p>
    <div class="split"><p class="big-num">${n}</p><p class="muted small">items · about ${Math.max(3, Math.round(n * 0.6))} min</p></div>
    <p class="small">Glue words, scene words, burned words and a line to answer, mixed together. It ends with you saying something of your own.</p>
    <a class="btn" href="#practice" data-action="practice-start">始める · Start</a></section>`;
}

function viewPractice(mode) {
  const onlyGlue = mode === "glue";
  if (!S.practiceRun || S.practiceRun.done || S.practiceRun.date !== todayKey() || S.practiceRun.onlyGlue !== onlyGlue) {
    const items = dailyItems(onlyGlue);
    if (!items.length) return `<a class="back" href="#today">← Today</a><section class="card"><h1 lang="ja">今日の練習</h1><p>Nothing due. お疲れさま！</p></section>`;
    S.practiceRun = { date: todayKey(), onlyGlue, items, i: 0, right: 0, graded: 0, used: [], done: false };
  }
  return `<a class="back" href="${onlyGlue ? "#scenes/glue" : "#today"}">← ${onlyGlue ? "Glue" : "Today"}</a>
    <section class="card review"><p class="eyebrow" lang="ja">${onlyGlue ? "つなぎ言葉" : "今日の練習"}</p><div id="pr-host"></div></section>`;
}

// Jobs of three words from other families, so each choice is clearly a different job.
function glueRoleOptions(e) {
  const others = shuffle((S.glue.glue || []).filter((x) => x.family !== e.family));
  const picked = [];
  const fams = new Set();
  for (const x of others) {
    if (picked.length >= 3) break;
    if (fams.has(x.family) && others.length > 6) continue;
    fams.add(x.family);
    picked.push({ e: x });
  }
  return shuffle([{ e, right: true }, ...picked]);
}

function mountPractice() {
  const host = document.getElementById("pr-host");
  const s = S.practiceRun;
  if (!host || !s) return;
  const grade = (id, ok) => {
    s.graded++;
    if (ok) s.right++;
    return srs.gradeItem(id, ok, s.date, S.config.syncUrl);
  };
  const next = () => {
    s.i++;
    draw();
    host.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const count = () => `<p class="ex-count">${s.i + 1} / ${s.items.length}</p>`;
  const twoButtons = (yes, no) => `<div class="row grade"><button class="btn ghost" data-g="1">${yes}</button><button class="btn ghost" data-g="0">${no}</button></div>`;
  const onGrade = (fn) =>
    host.querySelectorAll("[data-g]").forEach((b) =>
      b.addEventListener("click", () => {
        fn(b.dataset.g === "1");
        next();
      })
    );

  const draw = () => {
    if (s.i >= s.items.length) {
      s.done = true;
      host.innerHTML = `<h2 lang="ja">お疲れさまでした！</h2>
        ${s.graded ? `<p><b>${s.right} / ${s.graded}</b> right.</p>` : ""}
        <p class="small muted">Everything you answered went into its own review track, so tomorrow brings the right things back.</p>
        <div class="row"><a class="btn" href="#today">Back to Today</a>${grammarDueCount() ? `<a class="btn ghost" href="#review">Grammar review (${grammarDueCount()})</a>` : ""}</div>`;
      return;
    }
    const it = s.items[s.i];

    if (it.kind === "glue-new") {
      const e = it.e;
      host.innerHTML = `${count()}<p class="pill-inline">New · <span lang="ja">新しいつなぎ言葉</span></p>
        <h2 lang="ja" class="glue-big">${ja(e.ja)}</h2><p><b>${esc(e.does)}</b></p>${e.note ? `<p class="small">${rich(e.note)}</p>` : ""}
        ${e.examples.map(glueExampleCard).join("")}
        <p class="small muted">Say each line out loud once.</p>
        <div class="row"><button class="btn" data-next>次へ · Next</button></div>`;
      host.querySelector("[data-next]").onclick = next;
      return;
    }

    if (it.kind === "glue-gap") {
      // "What is this word doing here?" One right answer even when several words could fill the
      // slot, and it trains exactly what you need when you hear it: its job.
      const e = it.e;
      const ex = e.examples[(srs.state.rows.get(glueId(e))?.right || 0) % e.examples.length];
      const opts = glueRoleOptions(e);
      const plain = ex.ja.replace(/[«»]/g, "");
      host.innerHTML = `${count()}<p class="scene" lang="ja">この言葉は、ここで何をしている？</p>
        <p class="small muted">What is the highlighted word doing here?</p>
        <div class="ex-prompt">${jaMarked(ex.ja)} ${sayBtn(plain)}</div>
        <div class="opts opts-stack">${opts.map((o, k) => `<button class="opt" data-k="${k}">${esc(o.e.does)}</button>`).join("")}</div>
        <div class="ex-feedback"></div>`;
      speak(plain);
      host.querySelectorAll(".opt").forEach((b) =>
        b.addEventListener("click", () => {
          if (host.dataset.answered) return;
          host.dataset.answered = "1";
          const pick = opts[+b.dataset.k];
          const ok = !!pick.right;
          grade(glueId(e), ok);
          s.used.push(e);
          host.querySelectorAll(".opt").forEach((x) => {
            const o = opts[+x.dataset.k];
            x.classList.add(o.right ? "v-right" : "v-wrong");
            if (x === b) x.classList.add("picked");
            x.disabled = true;
          });
          host.querySelector(".ex-feedback").innerHTML = `
            <p class="verdict ${ok ? "v-right" : "v-wrong"}">${ok ? "Right" : "Not this one"}</p>
            <p class="en">${esc(ex.en)}</p>
            <ul class="whys">${[opts.find((o) => o.right), ...opts.filter((o) => !o.right)]
              .map((o) => `<li class="${o.right ? "v-right" : "v-wrong"}"><span class="why-opt" lang="ja">${esc(glueBare(o.e))}</span><p>${o.right ? `That's this word's job here. ${e.note ? rich(e.note) : ""}` : `That's the job of ${esc(glueBare(o.e))}, a different word.`}</p></li>`)
              .join("")}</ul>
            <div class="row"><button class="btn" data-next>次へ · Next</button></div>`;
          host.querySelector("[data-next]").onclick = () => {
            delete host.dataset.answered;
            next();
          };
        })
      );
      return;
    }

    if (it.kind === "glue-say") {
      const e = it.e;
      host.innerHTML = `${count()}<p class="scene" lang="ja">「${esc(glueBare(e))}」を使って、何か言ってみて。</p>
        <p class="small muted">Say something of your own with it, out loud. Anything true about your day.</p>
        <button class="reveal" aria-expanded="false">Show examples</button>
        <div class="hidden-en"><p class="small"><b>${esc(e.does)}</b></p>${e.examples.map(glueExampleCard).join("")}</div>
        ${twoButtons("言えた · Said it", "まだ · Not yet")}`;
      s.used.push(e);
      onGrade((ok) => grade(glueId(e), ok));
      return;
    }

    if (it.kind === "scene-word") {
      const v = it.v;
      const row = srs.state.rows.get(v.id);
      const produce = row && row.stage >= 3;
      host.innerHTML = `${count()}<p class="small muted">${esc(v.sc.titleEn)}</p>
        ${
          produce
            ? `<p class="scene" lang="ja">日本語で何と言う？</p><p class="recall-en">${esc(v.word.en)}</p>
               <button class="reveal" aria-expanded="false">Show</button><div class="hidden-en"><div class="jline">${ja(v.word.ja, "big")} ${sayBtn(v.word.ja)}</div></div>`
            : `<div class="jline">${ja(v.word.ja, "big")} ${sayBtn(v.word.ja)}</div><p class="scene" lang="ja">意味は？</p>
               <button class="reveal" aria-expanded="false">Show</button><div class="hidden-en"><p class="en">${esc(v.word.en)}</p></div>`
        }
        ${twoButtons("Got it", "Missed")}`;
      onGrade((ok) => {
        s.graded++;
        if (ok) s.right++;
        srs.gradeVoc(v.id, ok, s.date, S.config.syncUrl);
      });
      return;
    }

    if (it.kind === "warm") {
      const x = it.x;
      const sent = warmSentence(x.w);
      host.innerHTML = `${count()}<p class="small muted">Burned word</p>
        ${sent ? `<div class="jline">${jaMarked(sent.ja)} ${sayBtn(sent.ja.replace(/[«»]/g, ""))}</div>` : `<div class="jline"><span lang="ja" class="ja big">${esc(x.w)}</span></div>`}
        <p class="scene" lang="ja">意味と読み方は？</p>
        <button class="reveal" aria-expanded="false">Show</button><div class="hidden-en"><p><span lang="ja" class="ja big">${esc(x.w)}</span> <span lang="ja">${esc(x.r || "")}</span></p><p class="en"><b>${esc(x.m)}</b></p>${sent ? `<p class="small">${esc(sent.en)}</p>` : ""}</div>
        ${twoButtons("Got it", "Missed")}`;
      onGrade((ok) => {
        s.graded++;
        if (ok) s.right++;
        bumpWarmCount();
        srs.gradeWarm(x.w, ok, s.date, S.config.syncUrl);
      });
      return;
    }

    if (it.kind === "listen") {
      const { sc, it: li } = it;
      host.innerHTML = `${count()}<p class="small muted">${esc(sc.titleEn)}</p><p class="scene" lang="ja">聞いて、答えてみて。</p>
        <p class="small muted">Listen, then answer out loud before you look.</p>
        <div class="row"><button class="btn ghost" data-say="${esc(stripMarkup(li.line.ja))}">${ICON.sound} もう一度</button></div>
        <button class="reveal" aria-expanded="false">What they said</button><div class="hidden-en"><div class="jline">${ja(li.line.ja, "big")}</div><p class="en">${esc(li.line.en)}</p></div>
        <button class="reveal" aria-expanded="false">A reply</button><div class="hidden-en"><div class="jline">${ja(li.reply.ja, "big")} ${sayBtn(li.reply.ja)}</div><p class="en">${esc(li.reply.en)}</p></div>
        <div class="row"><button class="btn" data-next>次へ · Next</button></div>`;
      speak(li.line.ja);
      host.querySelector("[data-next]").onclick = next;
      return;
    }

    if (it.kind === "talk") {
      const p = S.selftalk[dayOfYear() % Math.max(1, S.selftalk.length)] || { q: "今日はどうでしたか。", ja: "", en: "How was today?" };
      const g = s.used.length ? s.used[s.used.length - 1] : null;
      host.innerHTML = `${count()}<p class="eyebrow" lang="ja">ひとりごと · Your turn</p>
        <p class="talk-q" lang="ja">${ja(p.q || p.ja)}</p>
        ${g ? `<p class="scene" lang="ja">「${esc(glueBare(g))}」も使ってみて。</p>` : ""}
        <p class="small muted">Answer out loud in two or three sentences. Don't translate; say what you can, the way you can.</p>
        <button class="reveal" aria-expanded="false">English / a start</button><div class="hidden-en"><p class="en">${esc(p.en)}</p>${p.ja ? `<p>${ja(p.ja)}</p>` : ""}</div>
        <div class="row"><button class="btn" data-next>言えた · Done</button></div>`;
      host.querySelector("[data-next]").onclick = next;
    }
  };
  draw();
}

function grammarDueCount() {
  return srs.dueToday(todayKey()).length;
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

const ROUTES = { today: viewToday, stats: viewStats, course: viewCourse, scenes: viewScenes, phrases: viewScenes, vault: viewVault, practice: viewPractice, notes: viewNotes, settings: viewSettings, review: viewReview, immerse: viewImmerse };

function render() {
  const [name, arg, arg2] = (location.hash.replace(/^#/, "") || "today").split("/");
  const fn = ROUTES[name] || viewToday;
  setChartWidth(Math.min(760, window.innerWidth) - 32 - 42);
  $app().innerHTML = fn(arg, arg2);
  const navName = name === "review" || name === "practice" ? "today" : name === "phrases" ? "scenes" : ROUTES[name] ? name : "today";
  document.querySelectorAll("nav a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === navName));
  setStatus();
  if (name === "course" && arg && S.lessonCache.has(arg)) mountExercises(S.lessonCache.get(arg));
  if (name === "review") mountReview();
  if (name === "scenes" || name === "phrases") mountScenes(arg);
  if (name === "practice") mountPractice();
  if (name === "vault") {
    if (arg === "warm") mountWarm();
    else if (arg === "quiz") mountVaultQuiz();
    else if (arg === "r" && arg2) mountReading(arg2);
  }
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
    if (t.matches("[data-vtier]")) {
      const set = vaultTiers();
      if (set.has(t.dataset.vtier)) set.delete(t.dataset.vtier);
      else set.add(t.dataset.vtier);
      if (!set.size) set.add(t.dataset.vtier);
      store.set("jh.vault.tiers", [...set]);
      S.vaultQuiz = null;
      return render();
    }
    const act = t.dataset.action;
    if (act === "practice-start") {
      S.practiceRun = null;
      if (location.hash === t.getAttribute("href")) {
        e.preventDefault();
        render();
      }
      return;
    }
    if (act === "heard-remove") {
      await srs.removeHeard(t.dataset.id, S.config.syncUrl);
      return render();
    }
    if (act === "vault-quiz") {
      S.vaultQuiz = null;
      if (location.hash === "#vault/quiz") {
        e.preventDefault();
        render();
      }
      return;
    }
    if (act === "reading-done") {
      await markReadingDone(t.dataset.id);
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
      return;
    }
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
