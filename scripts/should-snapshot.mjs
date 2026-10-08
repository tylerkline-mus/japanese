// Gate for the hourly-scheduled snapshot. GitHub actually fires "hourly" schedules only every
// 4–7 hours on a small repo, so a narrow evening window missed whole days. Every run now records
// the current study day (which rolls over at 4am), and the latest run of the day wins. The hub only
// trusts a row taken late in the evening as tomorrow's starting point, so an afternoon-only row
// still fills the heatmap and stats without skewing tomorrow's count.
// Manual runs (workflow_dispatch) always go ahead.
import { readFile, appendFile } from "node:fs/promises";
import { timeZoneFor } from "../assets/core.js";

const config = JSON.parse(await readFile(new URL("../data/config.json", import.meta.url), "utf8"));
const tz = timeZoneFor(config);
const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const go = true;
console.log(`Time zone ${tz}, local hour ${hour}, ${manual ? "manual run" : "scheduled"} → ${go ? "run" : "skip"}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `go=${go}\n`);
