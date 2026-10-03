// app.js — the hub. Static, no server: WaniKani + your Sheet + lesson files, combined in the browser.
import * as core from "./core.js";
import { esc, renderJa, stripMarkup, kanjiIn, parseCSV, speak, copyText, toast, store, fmt, daysUntil, dayOfYear } from "./util.js";
import { lineChart, barChart, stackBar, heatmap, meter, shortDate, setChartWidth } from "./charts.js";

const DEMO = new URLSearchParams(location.search).has("demo");
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
  curriculum: null,
  phrases: [],
  selftalk: [],
  error: null,
  loading: false,
};

const $app = () => document.getElementById("view");
const token = () => (DEMO ? "demo" : store.get("jh.token", ""));

// ---------------- boot ----------------

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function boot() {
  const [config, idx, curriculum, phrases, selftalk] = await Promise.all([
    getJSON("data/config.json"),
    getJSON("data/lessons/index.json"),
    getJSON("data/curriculum.json"),
    getJSON("data/phrases.json"),
    getJSON("data/selftalk.json"),
  ]);
  S.config = config;
  S.lessonsIndex = idx.lessons;
  S.curriculum = curriculum;
  S.phrases = phrases.phrases;
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

  // Show cached WaniKani data instantly, then refresh in the background.
  const cached = DEMO ? null : store.get("jh.wk", null);
  if (cached) {
    S.raw = cached.raw;
    S.rawAt = cached.at;
    buildModel();
  }
  render();
  await Promise.all([loadHistory(), loadNotes()]);
  if (S.raw) buildModel();
  render();
  await refreshWK(false);
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
  const q = core.queueNow(raw.summary, now);
  const target = core.dailyTarget(q.reviews);
  const live = core.snapshotRow(raw, tz, now);
  // Baseline: last night's snapshot if there is one; otherwise the first time
  // this device saw your numbers today (so reviews before that aren't counted).
  const liveMC = live.meaning[0];
  const prev = core.previousDayRow(S.history, live.date, tz);
  let dayBase = prev ? prev.meaning[0] : null;
  let baseSource = prev ? "snapshot" : "device";
  if (dayBase == null && !raw.demo) {
    const saved = store.get("jh.base", null);
    if (saved && saved.date === live.date && saved.mc <= liveMC) dayBase = saved.mc;
    else {
      dayBase = liveMC;
      store.set("jh.base", { date: live.date, mc: liveMC });
    }
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
  return `<span class="ja ${cls}" lang="ja">${renderJa(text, S.known)}</span>`;
}
function rich(text) {
  return renderJa(text, S.known).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
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

  if (!token()) return top + needToken() + selftalkCard() + lessonCard();
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
    ${m.baseSource === "device" ? `<p class="muted small">Counting from when this device first opened the hub today. From tomorrow it counts from last night's snapshot.</p>` : ""}
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

  return top + errorBanner() + target + lessonCard() + selftalkCard() + queueCard + leech;
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
  const progress = store.get("jh.course", {});
  const start = new Date(S.config.courseStart + "T00:00:00");
  const week = Math.max(1, Math.floor((Date.now() - start) / (7 * 86400000)) + 1);
  const firstOpen = S.lessonsIndex.find((l) => !progress[l.id]?.done);
  const thisWeek = S.lessonsIndex.find((l) => l.week === week);
  return { entry: firstOpen || thisWeek || S.lessonsIndex[S.lessonsIndex.length - 1], week, allDone: !firstOpen };
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
  </section>`;

  const groups = core.SRS_GROUPS.map((g) => ({ key: g.key, label: g.label, value: m.srs[g.key] }));
  const srs = `<section class="card"><h2>Where your items are</h2>${stackBar(groups)}</section>`;

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
  const tripKanji = [...new Set(S.phrases.flatMap((p) => kanjiIn(p.ja)))];
  const tripKnown = tripKanji.filter((k) => S.known.has(k)).length;
  const tripPct = tripKanji.length ? Math.round((tripKnown / tripKanji.length) * 100) : 0;
  const coverage = `<section class="card two">
    <div><h2>Kanji you can read</h2><p class="big-num">${fmt(knownN)}</p>${meter(knownN, core.JOYO_COUNT)}
      <p class="muted small">Guru or higher on WaniKani · ${Math.round((knownN / core.JOYO_COUNT) * 100)}% of the 2,136 jōyō kanji</p></div>
    <div><h2>Trip readiness</h2><p class="big-num">${tripPct}%</p>${meter(tripPct)}
      <p class="muted small">${tripKnown} of ${tripKanji.length} kanji in your trip phrases. <a href="#phrases">See phrases →</a></p></div>
  </section>`;

  const leeches = `<section class="card"><h2>Leeches</h2>
    ${m.leeches.length ? `<div class="leech-grid">${m.leeches.map(leechChip).join("")}</div>` : `<p class="muted">No leeches. Nice.</p>`}
    <p class="muted small">Ranked by misses weighed against how shaky each item is right now.</p>
  </section>`;

  const table = `<details class="card table-view"><summary>Daily snapshots (table)</summary>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Level</th><th>Queue</th><th>Reviewed</th></tr></thead><tbody>
    ${[...m.hist].reverse().map((h) => `<tr><td>${h.date}</td><td>${h.level}</td><td>${fmt(h.queue)}</td><td>${fmt(h.reviewedToday)}</td></tr>`).join("")}
    </tbody></table></div></details>`;

  return errorBanner() + tiles + srs + burn + heat + forecastCard + accCard + paceCard + coverage + leeches + table;
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
  const progress = store.get("jh.course", {});
  const lessonById = new Map(S.lessonsIndex.map((l) => [l.id, l]));
  const { entry } = currentLessonEntry();
  const sections = S.curriculum.sections
    .map(
      (sec) => `<section class="card"><h2>${esc(sec.name)}</h2><ol class="chapters">
      ${sec.chapters
        .map((c) => {
          const l = c.lesson && lessonById.get(c.lesson);
          const done = l && progress[l.id]?.done;
          return `<li class="${l ? "has-lesson" : ""} ${done ? "done" : ""}">
            <span class="ch-title">${esc(c.title)}</span>
            <span class="ch-links">
              ${l ? `<a class="pill ${l.id === entry.id ? "pill-em" : ""}" href="#course/${esc(l.id)}">${done ? "✓ Lesson" : "Lesson"}</a>` : ""}
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
  const done = store.get("jh.course", {})[l.id]?.done;
  return `<a class="back" href="#course">← Course</a>
  <article class="lesson">
    <header class="card">
      <p class="eyebrow">Lesson ${l.week}</p>
      <h1 lang="ja" class="lesson-title">${esc(l.title)}</h1>
      <p class="muted">${esc(l.titleEn)}</p>
      <p class="summary">${rich(l.summary)}</p>
      <p class="small"><a href="${esc(l.taeKim.url)}" target="_blank" rel="noopener">Tae Kim: ${esc(l.taeKim.title)} ↗</a></p>
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
      ${done ? `<p><b>Marked done.</b> Come back any time.</p>` : `<p>Finished reading and practicing?</p>`}
      <button class="btn ${done ? "ghost" : ""}" data-action="toggle-done" data-lesson="${esc(l.id)}">${done ? "Mark not done" : "Mark lesson done"}</button>
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
  const blank = (s) => renderJa(s, S.known).replace(/＿＿|＿/, '<span class="blank">＿</span>');
  host.innerHTML = `${head}
    <div class="ex-prompt"><span class="ja big" lang="ja">${blank(ex.prompt)}</span> ${sayBtn(ex.prompt.replace(/＿+/g, ""))}</div>
    <div class="opts">${ex.options.map((o, i) => `<button class="opt" data-i="${i}" lang="ja">${renderJa(o.text, S.known)}</button>`).join("")}</div>
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
          .map((o) => `<li class="v-${o.verdict}"><span class="why-opt" lang="ja">${renderJa(o.text, S.known)}</span><span class="why-tag">${VERDICT[o.verdict]}</span><p>${rich(o.why)}</p></li>`)
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
        picked.length ? picked.map((t, k) => `<button class="tile-btn on" data-k="${k}" lang="ja">${renderJa(ex.tiles[t], S.known)}</button>`).join("") : `<span class="muted small">Your sentence…</span>`
      }</div>
      <div class="build-bank">${tiles
        .map((t) => `<button class="tile-btn" data-t="${t.i}" ${picked.includes(t.i) ? "disabled" : ""} lang="ja">${renderJa(t.v, S.known)}</button>`)
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

// ---------- phrases ----------

function viewPhrases() {
  const cats = [...new Set(S.phrases.map((p) => p.category))];
  return `<section class="card intro"><h1>Trip phrases</h1>
    <p>Real moments from the trip. Read the Japanese first; kanji you know from WaniKani show without furigana.</p></section>
  ${cats
    .map(
      (c) => `<section class="card"><h2>${esc(c)}</h2>
      ${S.phrases
        .filter((p) => p.category === c)
        .map((p) => `<p class="scene">${esc(p.scene)}</p>${jaCard(p)}`)
        .join("")}</section>`
    )
    .join("")}`;
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
    <h2>Data</h2>
    <div class="row">
      <button class="btn ghost" data-action="refresh">${ICON.refresh} Refresh now</button>
      <button class="btn ghost" data-action="clear-cache">Clear saved data</button>
    </div>
    <p class="small muted">WaniKani refreshes automatically when you open the hub (every ${CACHE_MIN} minutes at most). Lesson progress is saved per device.</p>
    <h2>Links</h2>
    <p class="small"><a href="${esc(S.config.sheetCsv.replace(/\/pub\?output=csv$/, "/pubhtml"))}" target="_blank" rel="noopener">Published notes Sheet</a> · <a href="https://github.com/tylerkline-mus/japanese" target="_blank" rel="noopener">Repo</a> · <a href="?demo">Demo mode</a></p>
  </section>`;
}

// ---------------- router ----------------

const ROUTES = { today: viewToday, stats: viewStats, course: viewCourse, phrases: viewPhrases, notes: viewNotes, settings: viewSettings };

function render() {
  const [name, arg] = (location.hash.replace(/^#/, "") || "today").split("/");
  const fn = ROUTES[name] || viewToday;
  setChartWidth(Math.min(760, window.innerWidth) - 32 - 42);
  $app().innerHTML = fn(arg);
  document.querySelectorAll("nav a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (ROUTES[name] ? name : "today")));
  setStatus();
  if (name === "course" && arg && S.lessonCache.has(arg)) mountExercises(S.lessonCache.get(arg));
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
    if (t.matches("[data-say]")) {
      if (!speak(t.dataset.say)) toast("No Japanese voice on this device.");
      return;
    }
    if (t.matches("[data-ask]")) {
      const ok = await copyText(t.dataset.ask);
      toast(ok ? "Copied — paste it to Claude." : "Couldn't copy on this browser.");
      return;
    }
    if (t.matches("[data-tag]")) {
      S.noteTag = t.dataset.tag;
      return render();
    }
    const act = t.dataset.action;
    if (act === "toggle-done") {
      const rec = store.get("jh.course", {});
      const id = t.dataset.lesson;
      rec[id] = { ...(rec[id] || {}), done: !rec[id]?.done };
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
  const info = S.kanjiInfo.get(ch);
  const pop = document.getElementById("kpop") || Object.assign(document.createElement("div"), { id: "kpop", className: "kpop" });
  document.body.appendChild(pop);
  const stage = info ? S.stageBySubject.get(info.id) : null;
  const meanings = info ? info.meanings.map((m) => m.meaning).join(", ") : "";
  const on = info ? info.readings.filter((r) => r.type === "onyomi").map((r) => r.reading).join("、") : "";
  const kun = info ? info.readings.filter((r) => r.type === "kunyomi").map((r) => r.reading).join("、") : "";
  pop.innerHTML = info
    ? `<p class="kpop-ch" lang="ja">${esc(ch)}</p><p><b>${esc(meanings)}</b></p>
       ${on ? `<p class="small" lang="ja">音 ${esc(on)}</p>` : ""}${kun ? `<p class="small" lang="ja">訓 ${esc(kun)}</p>` : ""}
       <p class="small muted">Level ${info.level} · ${stageName(stage)}</p>
       <a class="small" href="${esc(info.document_url)}" target="_blank" rel="noopener">Open on WaniKani ↗</a>`
    : `<p class="kpop-ch" lang="ja">${esc(ch)}</p><p class="small muted">${S.raw ? "Not in your WaniKani levels yet." : "Connect WaniKani to see details."}</p>
       <a class="small" href="https://www.wanikani.com/kanji/${encodeURIComponent(ch)}" target="_blank" rel="noopener">Look it up ↗</a>`;
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
