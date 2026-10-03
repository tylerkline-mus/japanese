// Daily snapshot: records today's WaniKani numbers into data/history.json.
// Runs in GitHub Actions with the WANIKANI_TOKEN repository secret.
import { readFile, writeFile } from "node:fs/promises";
import { wkGet, wkGetAll, snapshotRow, previousDayRow, findLeeches, knownKanji } from "../assets/core.js";

const token = process.env.WANIKANI_TOKEN;
if (!token) {
  console.error("WANIKANI_TOKEN is not set. Add it under Settings → Secrets and variables → Actions.");
  process.exit(1);
}

const config = JSON.parse(await readFile(new URL("../data/config.json", import.meta.url), "utf8"));
const historyPath = new URL("../data/history.json", import.meta.url);

const [user, summary, assignments, stats] = await Promise.all([
  wkGet("/user", token),
  wkGet("/summary", token),
  wkGetAll("/assignments?unlocked=true&hidden=false", token),
  wkGetAll("/review_statistics?hidden=false", token),
]);

const row = snapshotRow({ user, summary, assignments, stats }, config.timeZone, new Date());

let history = [];
try {
  history = JSON.parse(await readFile(historyPath, "utf8"));
} catch {}
const prev = previousDayRow(history, row.date, config.timeZone);
row.reviewedToday = prev ? Math.max(0, row.meaning[0] - prev.meaning[0]) : null;
history = history.filter((h) => h.date !== row.date).concat([row]).sort((a, b) => a.date.localeCompare(b.date));
await writeFile(historyPath, JSON.stringify(history, null, 1) + "\n");
// What you know right now — read by the weekly lesson writer, which can't reach WaniKani itself.
const lvl = user.data.level;
const kanjiSubjects = await wkGetAll(`/subjects?types=kanji&levels=${Array.from({ length: lvl }, (_, i) => i + 1).join(",")}`, token);
const known = [...knownKanji(assignments, kanjiSubjects)];
const leech = findLeeches(stats, assignments, 15);
const leechSubjects = leech.length ? await wkGetAll(`/subjects?ids=${leech.map((l) => l.subject_id).join(",")}`, token) : [];
const byId = new Map(leechSubjects.map((x) => [x.id, x]));
const state = {
  updated: new Date().toISOString(),
  level: lvl,
  knownKanji: known.join(""),
  knownKanjiCount: known.length,
  leeches: leech
    .map((l) => {
      const x = byId.get(l.subject_id);
      if (!x) return null;
      return {
        characters: x.data.characters || x.data.slug,
        type: l.subject_type,
        meaning: (x.data.meanings || []).find((m) => m.primary)?.meaning || "",
        reading: (x.data.readings || []).find((r) => r.primary)?.reading || "",
        weak: l.weak,
      };
    })
    .filter(Boolean),
};
await writeFile(new URL("../data/wk-state.json", import.meta.url), JSON.stringify(state, null, 1) + "\n");

console.log(`Snapshot ${row.date}: level ${row.level}, queue ${row.queue}, reviewed today ${row.reviewedToday}`);

// Grammar review progress from the Sheet (via the Apps Script), for the weekly lesson writer.
// Needs the SYNC_KEY secret; skipped quietly if it isn't set.
const syncKey = process.env.SYNC_KEY;
if (config.syncUrl && syncKey) {
  try {
    const res = await fetch(`${config.syncUrl}?action=get&key=${encodeURIComponent(syncKey)}`, { redirect: "follow" });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "refused");
    const items = body.items.map((r) => ({
      id: r.id,
      stage: Number(r.stage) || 0,
      due: r.due,
      right: Number(r.right) || 0,
      wrong: Number(r.wrong) || 0,
    }));
    await writeFile(new URL("../data/grammar-progress.json", import.meta.url), JSON.stringify({ updated: new Date().toISOString(), items }, null, 1) + "\n");
    console.log(`Grammar progress: ${items.length} points`);
  } catch (e) {
    console.log(`Grammar progress not updated: ${e.message}`);
  }
} else {
  console.log("Grammar progress skipped (no SYNC_KEY secret).");
}

