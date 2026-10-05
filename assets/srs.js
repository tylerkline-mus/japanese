// srs.js — grammar spaced repetition, synced through a Google Sheet (Apps Script web app).
// One review item per grammar point. Each review shows a few different sentences for that
// point, mixed in with other points, so you learn the rule rather than memorize a sentence.
import { store } from "./util.js";

export const INTERVALS = [1, 3, 7, 14, 30, 90]; // days for steps 1–6; step 7 = retired
export const DRILLS_PER_POINT = 3;
export const MAX_POINTS_PER_DAY = 4; // ~12 sentences a day at most — never piles up
const SEEN_KEEP = 8;

let LOCAL_KEY = "jh.srs";
let DEMO = false;
// Demo mode keeps its own progress and never touches the Sheet.
export function useDemo() {
  DEMO = true;
  LOCAL_KEY = "jh.demo.srs";
}
const SYNC_KEY = "jh.sync";

export function addDays(dateKey, n) {
  const d = new Date(Date.parse(dateKey + "T12:00:00Z") + n * 86400000);
  return d.toISOString().slice(0, 10);
}

export function stageLabel(stage) {
  if (!stage) return "Not started";
  if (stage >= 7) return "Retired";
  return `Step ${stage} of 6`;
}

// ---------- state ----------

export const state = {
  rows: new Map(), // id → {id, stage, due, right, wrong, seen, updated}
  sync: "local", // local | ok | error | syncing
  syncError: null,
};

export function syncConfig(defaultUrl) {
  const c = store.get(SYNC_KEY, {}) || {};
  return { url: c.url || defaultUrl || "", key: c.key || "" };
}
export function saveSyncConfig(url, key) {
  store.set(SYNC_KEY, { url: url.trim(), key: key.trim() });
}
const syncOn = (cfg) => !DEMO && !!(cfg.url && cfg.key);

function readLocal() {
  const arr = store.get(LOCAL_KEY, []) || [];
  return new Map(arr.map((r) => [r.id, r]));
}
function writeLocal() {
  store.set(LOCAL_KEY, [...state.rows.values()]);
}

function normalize(r) {
  return {
    id: String(r.id),
    stage: Number(r.stage) || 0,
    due: String(r.due || ""),
    right: Number(r.right) || 0,
    wrong: Number(r.wrong) || 0,
    seen: String(r.seen || ""),
    updated: String(r.updated || ""),
  };
}

// ---------- sheet sync ----------

async function remoteGet(cfg) {
  const url = `${cfg.url}?action=get&key=${encodeURIComponent(cfg.key)}`;
  const res = await fetch(url, { redirect: "follow" });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || "Sheet sync refused the request");
  return body.items.map(normalize);
}

async function remotePut(cfg, items) {
  // text/plain keeps this a "simple" request, which Apps Script accepts from a browser.
  const res = await fetch(cfg.url, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "put", key: cfg.key, items }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || "Sheet sync refused the write");
  return true;
}

export async function testSync(url, key) {
  await remoteGet({ url, key });
  return true;
}

// Load local first (instant), then merge with the Sheet: newest `updated` wins per item.
export async function load(defaultUrl) {
  state.rows = readLocal();
  const cfg = syncConfig(defaultUrl);
  if (!syncOn(cfg)) {
    state.sync = "local";
    return;
  }
  state.sync = "syncing";
  try {
    const remote = await remoteGet(cfg);
    const toPush = [];
    const merged = new Map(remote.map((r) => [r.id, r]));
    for (const [id, local] of state.rows) {
      const r = merged.get(id);
      if (!r || local.updated > r.updated) {
        merged.set(id, local);
        toPush.push(local);
      }
    }
    state.rows = merged;
    writeLocal();
    if (toPush.length) await remotePut(cfg, toPush);
    state.sync = "ok";
    state.syncError = null;
  } catch (e) {
    state.sync = "error";
    state.syncError = e.message || String(e);
  }
}

async function save(items, defaultUrl) {
  for (const it of items) state.rows.set(it.id, it);
  writeLocal();
  const cfg = syncConfig(defaultUrl);
  if (!syncOn(cfg)) return;
  try {
    await remotePut(cfg, items);
    state.sync = "ok";
    state.syncError = null;
  } catch (e) {
    // Kept locally; the next load pushes it (local is newer).
    state.sync = "error";
    state.syncError = e.message || String(e);
  }
}

// ---------- scheduling ----------

const nowIso = () => new Date().toISOString();

export function isEnrolled(id) {
  const r = state.rows.get(id);
  return !!(r && r.stage > 0);
}

export async function enroll(id, todayKey, defaultUrl) {
  const prev = state.rows.get(id);
  const row = { ...(prev || { right: 0, wrong: 0, seen: "" }), id, stage: 1, due: addDays(todayKey, 1), updated: nowIso() };
  await save([normalize(row)], defaultUrl);
}

export async function unenroll(id, defaultUrl) {
  const prev = state.rows.get(id);
  if (!prev) return;
  await save([{ ...prev, stage: 0, due: "", updated: nowIso() }], defaultUrl);
}

// Grammar points have plain ids ("02-ni-de"). Other kinds ride along with a prefix
// ("imm:…", "voc:…") and never count as grammar.
export const isGrammar = (id) => !String(id).includes(":");

export function dueList(todayKey) {
  return [...state.rows.values()]
    .filter((r) => isGrammar(r.id) && r.stage >= 1 && r.stage <= 6 && r.due && r.due <= todayKey)
    .sort((a, b) => a.due.localeCompare(b.due) || a.stage - b.stage);
}

export function dueToday(todayKey) {
  return dueList(todayKey).slice(0, MAX_POINTS_PER_DAY);
}

export function nextDue(todayKey) {
  const upcoming = [...state.rows.values()].filter((r) => isGrammar(r.id) && r.stage >= 1 && r.stage <= 6 && r.due > todayKey).map((r) => r.due).sort();
  return upcoming[0] || null;
}

// Pick drills for a point, avoiding the ones seen most recently.
export function pickDrills(row, drills, n = DRILLS_PER_POINT) {
  const seen = new Set((row.seen || "").split(",").filter(Boolean));
  const fresh = drills.filter((d) => !seen.has(d.id));
  const pool = fresh.length >= n ? fresh : fresh.concat(drills.filter((d) => seen.has(d.id)));
  const shuffled = pool
    .map((d) => ({ d, k: Math.random() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.d);
  return shuffled.slice(0, n);
}

// Grade one point after its drills: all right → step up; one miss → same step again;
// more misses → step down. Wrong answers come back sooner, like WaniKani.
export async function grade(id, right, total, drillIds, todayKey, defaultUrl) {
  const prev = state.rows.get(id);
  if (!prev) return null;
  const missed = total - right;
  let stage = prev.stage;
  if (missed === 0) stage = Math.min(7, stage + 1);
  else if (missed >= 2) stage = Math.max(1, stage - 1);
  const due = stage >= 7 ? "" : addDays(todayKey, INTERVALS[stage - 1]);
  const seen = [...drillIds, ...(prev.seen || "").split(",").filter(Boolean)].filter((v, i, a) => a.indexOf(v) === i).slice(0, SEEN_KEEP).join(",");
  const row = { ...prev, stage, due, right: prev.right + right, wrong: prev.wrong + missed, seen, updated: nowIso() };
  await save([row], defaultUrl);
  return { before: prev.stage, after: stage, due };
}

// ---------- immersion log (rides along in the same Sheet tab) ----------
// Rows look like {id: "imm:<item id>", stage: 0, right: <minutes>, seen: "done"} so they never
// count as grammar reviews.

export function immDone(id) {
  const r = state.rows.get("imm:" + id);
  return !!(r && r.seen === "done");
}

export async function setImm(id, minutes, done, defaultUrl) {
  const row = { id: "imm:" + id, stage: 0, due: "", right: done ? Math.max(0, Math.round(minutes || 0)) : 0, wrong: 0, seen: done ? "done" : "", updated: nowIso() };
  await save([row], defaultUrl);
}

export function immLog() {
  return [...state.rows.values()].filter((r) => r.id.startsWith("imm:") && r.seen === "done");
}

// ---------- scene vocabulary ----------
// Rows look like {id: "voc:<scene id>:<word id>", stage 1–7, due, right, wrong}. One card per word,
// graded one at a time: right → step up, wrong → step back. A small daily cap keeps it light.

export const VOC_PER_DAY = 10;
export const VOC_NEW_PER_DAY = 5;
export const vocId = (sceneId, wordId) => `voc:${sceneId}:${wordId}`;

export function vocRows() {
  return [...state.rows.values()].filter((r) => r.id.startsWith("voc:") && r.stage >= 1);
}

export function vocDue(todayKey) {
  return vocRows()
    .filter((r) => r.stage <= 6 && r.due && r.due <= todayKey)
    .sort((a, b) => a.due.localeCompare(b.due) || a.stage - b.stage);
}

// New words introduced today (first answered today), so the new-word cap holds across sessions.
export function vocNewToday(todayKey) {
  return vocRows().filter((r) => (r.seen || "").startsWith("new:" + todayKey)).length;
}

export async function gradeVoc(id, ok, todayKey, defaultUrl) {
  const prev = state.rows.get(id);
  const isNew = !prev || !prev.stage;
  let stage;
  if (isNew) stage = 1;
  else if (ok) stage = Math.min(7, prev.stage + 1);
  else stage = Math.max(1, prev.stage - 1);
  const due = stage >= 7 ? "" : addDays(todayKey, INTERVALS[stage - 1]);
  const row = {
    id,
    stage,
    due,
    right: (prev?.right || 0) + (ok ? 1 : 0),
    wrong: (prev?.wrong || 0) + (ok ? 0 : 1),
    seen: isNew ? "new:" + todayKey : prev.seen || "",
    updated: nowIso(),
  };
  await save([normalize(row)], defaultUrl);
  return row;
}

// ---------- keeping burned words warm ----------
// Rows look like {id: "brn:<word>", stage, due, right, wrong, seen: <date last refreshed>}.
// Every burned word comes back about every 75 days (spread ±10 so they don't arrive in clumps).
// A miss brings it back in a week.

export const WARM_DAYS = 75;
export const WARM_PER_DAY = 10;
export const warmId = (w) => "brn:" + w;
export const warmRow = (w) => state.rows.get(warmId(w));

function spread(w) {
  let h = 0;
  for (const c of w) h = (h * 31 + c.codePointAt(0)) % 997;
  return (h % 21) - 10;
}

// words: [{w, l}]. Overdue refreshes first (oldest first), then words never refreshed: ones with a
// written sentence first (prio), then a stable shuffle so the trivial early words don't all come first.
export function warmDue(words, todayKey, cap = WARM_PER_DAY, prio = () => 0) {
  if (cap <= 0) return [];
  const due = [];
  const fresh = [];
  for (const x of words) {
    const r = warmRow(x.w);
    if (!r || !r.due) fresh.push(x);
    else if (r.due <= todayKey) due.push({ x, due: r.due });
  }
  due.sort((a, b) => a.due.localeCompare(b.due));
  fresh.sort((a, b) => prio(b) - prio(a) || spread(a.w + "#") - spread(b.w + "#") || a.w.localeCompare(b.w));
  return [...due.map((d) => d.x), ...fresh].slice(0, cap);
}

function warmRowFor(w, ok, todayKey) {
  const prev = warmRow(w);
  return normalize({
    id: warmId(w),
    stage: ok ? Math.min(6, (prev?.stage || 0) + 1) : 1,
    due: ok ? addDays(todayKey, WARM_DAYS + spread(w)) : addDays(todayKey, 7),
    right: (prev?.right || 0) + (ok ? 1 : 0),
    wrong: (prev?.wrong || 0) + (ok ? 0 : 1),
    seen: todayKey,
    updated: nowIso(),
  });
}

export async function gradeWarm(w, ok, todayKey, defaultUrl) {
  const row = warmRowFor(w, ok, todayKey);
  await save([row], defaultUrl);
  return row;
}

// Reading a passage counts as seeing its burned words (unless one is already due later than that).
export async function markWarm(words, todayKey, defaultUrl) {
  const target = addDays(todayKey, WARM_DAYS - 10);
  const rows = words.filter((w) => !(warmRow(w)?.due > target)).map((w) => warmRowFor(w, true, todayKey));
  if (rows.length) await save(rows, defaultUrl);
  return rows.length;
}

export function warmStats(words, todayKey) {
  const since = addDays(todayKey, -90);
  let warm = 0;
  for (const x of words) {
    const r = warmRow(x.w);
    if (r && r.seen && r.seen >= since) warm++;
  }
  return { warm, total: words.length };
}

// Simple done/not-done flags (e.g. "vr:<reading id>"), riding along in the same Sheet tab.
export function flag(id) {
  const r = state.rows.get(id);
  return !!(r && r.seen === "done");
}
export async function setFlag(id, on, defaultUrl) {
  await save([normalize({ id, stage: 0, due: "", right: 0, wrong: 0, seen: on ? "done" : "", updated: nowIso() })], defaultUrl);
}
