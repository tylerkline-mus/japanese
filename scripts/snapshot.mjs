// Daily snapshot: records today's WaniKani numbers into data/history.json.
// Runs in GitHub Actions with the WANIKANI_TOKEN repository secret.
import { readFile, writeFile } from "node:fs/promises";
import { wkGet, wkGetAll, snapshotRow, previousDayRow } from "../assets/core.js";

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
console.log(`Snapshot ${row.date}: level ${row.level}, queue ${row.queue}, reviewed today ${row.reviewedToday}`);
