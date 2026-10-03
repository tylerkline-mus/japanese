// core.js — pure logic shared by the browser hub and the daily snapshot script.
// No DOM access in here, so Node can import it too.

export const WK_BASE = "https://api.wanikani.com/v2";
export const WK_REVISION = "20170710";

export const SRS_GROUPS = [
  { key: "apprentice", label: "Apprentice", stages: [1, 2, 3, 4] },
  { key: "guru", label: "Guru", stages: [5, 6] },
  { key: "master", label: "Master", stages: [7] },
  { key: "enlightened", label: "Enlightened", stages: [8] },
  { key: "burned", label: "Burned", stages: [9] },
];

export const JOYO_COUNT = 2136;

// ---------- WaniKani fetching ----------

export async function wkGet(path, token, fetchImpl = fetch) {
  const url = path.startsWith("http") ? path : WK_BASE + path;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Wanikani-Revision": WK_REVISION,
    },
  });
  if (res.status === 401) throw new Error("WaniKani rejected the token (401). Check it in Settings.");
  if (res.status === 429) throw new Error("WaniKani rate limit hit. Try again in a minute.");
  if (!res.ok) throw new Error(`WaniKani error ${res.status} on ${path}`);
  return res.json();
}

export async function wkGetAll(path, token, fetchImpl = fetch) {
  let next = path;
  const out = [];
  while (next) {
    const page = await wkGet(next, token, fetchImpl);
    out.push(...page.data);
    next = page.pages && page.pages.next_url;
  }
  return out;
}

// Pulls everything the hub needs in as few calls as possible.
export async function fetchRaw(token, fetchImpl = fetch) {
  const [user, summary, assignments, stats, levels] = await Promise.all([
    wkGet("/user", token, fetchImpl),
    wkGet("/summary", token, fetchImpl),
    wkGetAll("/assignments?unlocked=true&hidden=false", token, fetchImpl),
    wkGetAll("/review_statistics?hidden=false", token, fetchImpl),
    wkGetAll("/level_progressions", token, fetchImpl),
  ]);
  const lvl = user.data.level;
  const levelList = Array.from({ length: lvl }, (_, i) => i + 1).join(",");
  const kanjiSubjects = await wkGetAll(`/subjects?types=kanji&levels=${levelList}`, token, fetchImpl);

  // Look up the subjects behind the worst leeches (any type).
  const prelim = findLeeches(stats, assignments, 15);
  const ids = prelim.map((l) => l.subject_id);
  const leechSubjects = ids.length
    ? await wkGetAll(`/subjects?ids=${ids.join(",")}`, token, fetchImpl)
    : [];

  return { user, summary, assignments, stats, levels, kanjiSubjects, leechSubjects };
}

// ---------- calculations ----------

export function localDateKey(date, timeZone) {
  // YYYY-MM-DD in the given zone (or the runtime's local zone).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function tzOffsetMinutes(date, timeZone) {
  // e.g. "GMT-04:00" → -240
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName").value;
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  const mins = parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10);
  return m[1] === "-" ? -mins : mins;
}

export function startOfLocalDay(now, timeZone) {
  // Midnight of "today" in timeZone, as a Date.
  const key = localDateKey(now, timeZone);
  const offset = tzOffsetMinutes(now, timeZone);
  return new Date(Date.parse(key + "T00:00:00Z") - offset * 60000);
}

export function queueNow(summary, now = new Date()) {
  let reviews = 0;
  let lessons = 0;
  for (const b of summary.data.reviews || []) {
    if (Date.parse(b.available_at) <= now.getTime()) reviews += b.subject_ids.length;
  }
  for (const b of summary.data.lessons || []) {
    if (Date.parse(b.available_at) <= now.getTime()) lessons += b.subject_ids.length;
  }
  return { reviews, lessons };
}

// The dig-out plan, in one function. Keep it gentle.
export function dailyTarget(queue) {
  if (queue <= 0) return { target: 0, mode: "clear", lessonsOk: true };
  if (queue <= 100) return { target: queue, mode: "maintain", lessonsOk: true };
  if (queue >= 400) return { target: 100, mode: "dig", lessonsOk: false };
  if (queue >= 200) return { target: 80, mode: "dig", lessonsOk: false };
  return { target: 60, mode: "dig", lessonsOk: false };
}

export function srsBreakdown(assignments) {
  const counts = Object.fromEntries(SRS_GROUPS.map((g) => [g.key, 0]));
  for (const a of assignments) {
    const s = a.data.srs_stage;
    const g = SRS_GROUPS.find((g) => g.stages.includes(s));
    if (g) counts[g.key] += 1;
  }
  return counts;
}

export function accuracyTotals(stats) {
  const byType = {
    radical: { correct: 0, incorrect: 0 },
    kanji: { correct: 0, incorrect: 0 },
    vocabulary: { correct: 0, incorrect: 0 },
  };
  const meaning = { correct: 0, incorrect: 0 };
  const reading = { correct: 0, incorrect: 0 };
  for (const s of stats) {
    const d = s.data;
    const t = d.subject_type === "kana_vocabulary" ? "vocabulary" : d.subject_type;
    const c = (d.meaning_correct || 0) + (d.reading_correct || 0);
    const i = (d.meaning_incorrect || 0) + (d.reading_incorrect || 0);
    if (byType[t]) {
      byType[t].correct += c;
      byType[t].incorrect += i;
    }
    meaning.correct += d.meaning_correct || 0;
    meaning.incorrect += d.meaning_incorrect || 0;
    if (t !== "radical" && d.subject_type !== "kana_vocabulary") {
      reading.correct += d.reading_correct || 0;
      reading.incorrect += d.reading_incorrect || 0;
    }
  }
  const correct = meaning.correct + reading.correct;
  const incorrect = meaning.incorrect + reading.incorrect;
  return { byType, meaning, reading, correct, incorrect };
}

export function pct(c, i) {
  const t = c + i;
  return t ? Math.round((c / t) * 1000) / 10 : null;
}

// Reviews completed = growth in total correct *meaning* answers. Every finished
// review ends with exactly one correct meaning answer (wrong tries are retried in
// the session), so this counts reviews, not items whose records happened to change.
export function meaningCorrectTotal(stats) {
  let n = 0;
  for (const s of stats) n += s.data.meaning_correct || 0;
  return n;
}

// Pick the baseline row for "today": the most recent snapshot from yesterday.
export function previousDayRow(history, todayKey, timeZone) {
  const y = new Date(Date.parse(todayKey + "T12:00:00Z") - 86400000);
  const yKey = localDateKey(y, "UTC");
  const prev = [...history].filter((h) => h.date < todayKey).sort((a, b) => a.date.localeCompare(b.date)).pop();
  return prev && prev.date === yKey && Array.isArray(prev.meaning) ? prev : null;
}

// Leech score: wrong answers weighed against how shaky the item currently is.
export function findLeeches(stats, assignments, limit = 12) {
  const stage = new Map(assignments.map((a) => [a.data.subject_id, a.data.srs_stage]));
  const scored = [];
  for (const s of stats) {
    const d = s.data;
    const st = stage.get(d.subject_id);
    if (st === undefined || st >= 9) continue;
    const m = (d.meaning_incorrect || 0) / Math.pow(Math.max(d.meaning_current_streak || 1, 1), 1.5);
    const r = (d.reading_incorrect || 0) / Math.pow(Math.max(d.reading_current_streak || 1, 1), 1.5);
    const score = Math.max(m, r);
    if (score >= 1) {
      scored.push({
        subject_id: d.subject_id,
        subject_type: d.subject_type,
        score: Math.round(score * 10) / 10,
        weak: r > m ? "reading" : "meaning",
        incorrect: (d.meaning_incorrect || 0) + (d.reading_incorrect || 0),
        percentage: d.percentage_correct,
        srs: st,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function levelPace(levels, now = new Date()) {
  const rows = levels
    .map((l) => l.data)
    .filter((d) => d.unlocked_at && !d.abandoned_at)
    .sort((a, b) => a.level - b.level);
  // Keep only the latest progression per level (resets create duplicates).
  const byLevel = new Map();
  for (const r of rows) byLevel.set(r.level, r);
  const list = [...byLevel.values()].sort((a, b) => a.level - b.level);
  const day = 86400000;
  const done = list
    .filter((d) => d.passed_at)
    .map((d) => ({
      level: d.level,
      days: Math.round(((Date.parse(d.passed_at) - Date.parse(d.started_at || d.unlocked_at)) / day) * 10) / 10,
    }));
  const current = list.find((d) => !d.passed_at);
  const currentDays = current
    ? Math.round(((now.getTime() - Date.parse(current.started_at || current.unlocked_at)) / day) * 10) / 10
    : null;
  const recent = done.slice(-5);
  const avg = recent.length ? recent.reduce((s, d) => s + d.days, 0) / recent.length : null;
  return { done, current: current ? { level: current.level, days: currentDays } : null, avgRecent: avg };
}

export function forecast(assignments, timeZone, days = 7, now = new Date()) {
  const out = [];
  const todayKey = localDateKey(now, timeZone);
  const keys = [];
  for (let i = 0; i < days; i++) {
    const k = localDateKey(new Date(now.getTime() + i * 86400000), timeZone);
    if (!keys.includes(k)) keys.push(k);
  }
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  let overdue = 0;
  for (const a of assignments) {
    const d = a.data;
    if (!d.available_at || d.srs_stage < 1 || d.srs_stage > 8) continue;
    const t = Date.parse(d.available_at);
    if (t <= now.getTime()) {
      overdue += 1;
      continue;
    }
    const k = localDateKey(new Date(t), timeZone);
    if (k in counts) counts[k] += 1;
  }
  for (const k of keys) out.push({ date: k, count: counts[k], isToday: k === todayKey });
  return { overdue, days: out };
}

export function knownKanji(assignments, kanjiSubjects, minStage = 5) {
  const chars = new Map(kanjiSubjects.map((s) => [s.id, s.data.characters]));
  const known = new Set();
  for (const a of assignments) {
    if (a.data.subject_type !== "kanji") continue;
    if (a.data.srs_stage >= minStage && chars.has(a.data.subject_id)) known.add(chars.get(a.data.subject_id));
  }
  return known;
}

// Vocabulary you've unlocked, with your SRS stage — for word-level "do I know this?" checks.
// Kept compact: w = word, r = primary reading, m = primary meaning, s = SRS stage, l = level.
export function vocabList(assignments, vocabSubjects) {
  const stage = new Map(assignments.map((a) => [a.data.subject_id, a.data.srs_stage]));
  const out = [];
  for (const v of vocabSubjects) {
    const st = stage.get(v.id);
    if (st == null || st < 1) continue;
    const d = v.data;
    out.push({
      w: d.characters,
      r: (d.readings || []).find((x) => x.primary)?.reading || (v.object === "kana_vocabulary" ? d.characters : ""),
      m: (d.meanings || []).find((x) => x.primary)?.meaning || "",
      s: st,
      l: d.level,
    });
  }
  return out.sort((a, b) => a.l - b.l || a.w.localeCompare(b.w));
}

// Compact snapshot row — what the daily Action writes to data/history.json.
export function snapshotRow(raw, timeZone, now = new Date()) {
  const q = queueNow(raw.summary, now);
  const srs = srsBreakdown(raw.assignments);
  const acc = accuracyTotals(raw.stats);
  return {
    date: localDateKey(now, timeZone),
    level: raw.user.data.level,
    queue: q.reviews,
    lessons: q.lessons,
    srs,
    correct: acc.correct,
    incorrect: acc.incorrect,
    meaning: [acc.meaning.correct, acc.meaning.incorrect],
    reading: [acc.reading.correct, acc.reading.incorrect],
    byType: Object.fromEntries(Object.entries(acc.byType).map(([k, v]) => [k, [v.correct, v.incorrect]])),
    reviewedToday: null, // filled in by the caller, which knows yesterday's total
  };
}

// Accuracy between two snapshot rows (e.g. this week).
export function accuracyBetween(older, newer) {
  if (!older || !newer) return null;
  const c = newer.correct - older.correct;
  const i = newer.incorrect - older.incorrect;
  if (c + i <= 0) return null;
  return { correct: c, incorrect: i, pct: pct(c, i) };
}
