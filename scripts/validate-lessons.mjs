// Fails the build if any lesson exercise is missing an explanation.
// This is the rule that keeps the hub from turning into Bunpro: every answer explains itself.
import { readFile } from "node:fs/promises";

const dir = new URL("../data/lessons/", import.meta.url);
const index = JSON.parse(await readFile(new URL("index.json", dir), "utf8"));
const problems = [];
const ids = new Set();

for (const entry of index.lessons) {
  const where = entry.file;
  let l;
  try {
    l = JSON.parse(await readFile(new URL(entry.file, dir), "utf8"));
  } catch (e) {
    problems.push(`${where}: can't read or parse (${e.message})`);
    continue;
  }
  if (l.id !== entry.id) problems.push(`${where}: id "${l.id}" doesn't match index "${entry.id}"`);
  if (ids.has(l.id)) problems.push(`${where}: duplicate id ${l.id}`);
  ids.add(l.id);
  for (const k of ["title", "titleEn", "summary", "explanation", "examples", "contrasts", "exercises", "taeKim"]) {
    if (!l[k] || (Array.isArray(l[k]) && !l[k].length)) problems.push(`${where}: missing ${k}`);
  }
  (l.examples || []).forEach((e, i) => { if (!e.ja || !e.en) problems.push(`${where}: example ${i + 1} needs ja and en`); });
  (l.contrasts || []).forEach((c, i) => { if (!c.a?.ja || !c.b?.ja || !c.why) problems.push(`${where}: contrast ${i + 1} needs a, b and why`); });
  (l.exercises || []).forEach((ex, i) => {
    const at = `${where}: exercise ${i + 1} (${ex.type})`;
    if (ex.type === "choice") {
      if (!ex.prompt) problems.push(`${at}: missing prompt`);
      if (!ex.options || ex.options.length < 2) problems.push(`${at}: needs at least 2 options`);
      if (!(ex.options || []).some((o) => o.verdict === "right")) problems.push(`${at}: no option marked right`);
      (ex.options || []).forEach((o, j) => {
        if (!o.why || !o.why.trim()) problems.push(`${at}: option ${j + 1} ("${o.text}") has no explanation`);
        if (!["right", "wrong", "different"].includes(o.verdict)) problems.push(`${at}: option ${j + 1} has an unknown verdict`);
      });
    } else if (ex.type === "build") {
      if (!ex.tiles?.length || !ex.answers?.length || !ex.why) problems.push(`${at}: needs tiles, answers and why`);
      for (const a of ex.answers || []) for (const t of a) if (!ex.tiles.includes(t)) problems.push(`${at}: answer uses a tile that isn't in tiles: ${t}`);
    } else if (ex.type === "write") {
      if (!ex.model || !ex.why) problems.push(`${at}: needs model and why`);
    } else problems.push(`${at}: unknown exercise type`);
  });
}

if (problems.length) {
  console.error(problems.map((p) => "✕ " + p).join("\n"));
  process.exit(1);
}
console.log(`✓ ${index.lessons.length} lessons, every answer explained.`);
