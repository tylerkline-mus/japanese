// Gate for the hourly-scheduled snapshot: run in the 9, 10 and 11pm hours of whatever time zone
// the travel schedule says you're in. Each run replaces the day's row, so the latest one wins —
// and if GitHub skips a scheduled run (it often does), there are still two more chances.
// Manual runs (workflow_dispatch) always go ahead.
import { readFile, appendFile } from "node:fs/promises";
import { timeZoneFor } from "../assets/core.js";

const config = JSON.parse(await readFile(new URL("../data/config.json", import.meta.url), "utf8"));
const tz = timeZoneFor(config);
const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const go = manual || hour >= 21;
console.log(`Time zone ${tz}, local hour ${hour}, ${manual ? "manual run" : "scheduled"} → ${go ? "run" : "skip"}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `go=${go}\n`);
