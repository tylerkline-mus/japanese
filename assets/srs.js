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

export function dueList(todayKey) {
  return [...state.rows.values()]
    .filter((r) => r.stage >= 1 && r.stage <= 6 && r.due && r.due <= todayKey)
    .sort((a, b) => a.due.localeCompare(b.due) || a.stage - b.stage);
}

export function dueToday(todayKey) {
  return dueList(todayKey).slice(0, MAX_POINTS_PER_DAY);
}

export function nextDue(todayKey) {
  const upcoming = [...state.rows.values()].filter((r) => r.stage >= 1 && r.stage <= 6 && r.due > todayKey).map((r) => r.due).sort();
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
