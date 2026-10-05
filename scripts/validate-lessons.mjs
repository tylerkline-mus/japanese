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

// Review sentence banks (data/grammar/<lesson id>.json)
import { readdir } from "node:fs/promises";
const gdir = new URL("../data/grammar/", import.meta.url);
let bankCount = 0;
for (const f of (await readdir(gdir).catch(() => [])).filter((f) => f.endsWith(".json"))) {
  const where = "grammar/" + f;
  let b;
  try {
    b = JSON.parse(await readFile(new URL(f, gdir), "utf8"));
  } catch (e) {
    problems.push(`${where}: can't read or parse (${e.message})`);
    continue;
  }
  bankCount++;
  if (!ids.has(b.lesson)) problems.push(`${where}: lesson "${b.lesson}" isn't in the lesson index`);
  if (f !== `${b.lesson}.json`) problems.push(`${where}: file should be named ${b.lesson}.json`);
  const seen = new Set();
  (b.drills || []).forEach((ex, i) => {
    const at = `${where}: drill ${i + 1} (${ex.id || "no id"})`;
    if (!ex.id) problems.push(`${at}: needs an id`);
    else if (seen.has(ex.id)) problems.push(`${at}: duplicate id`);
    seen.add(ex.id);
    if (ex.type === "choice") {
      if (!ex.prompt || !ex.en) problems.push(`${at}: needs prompt and en`);
      if (!(ex.options || []).some((o) => o.verdict === "right")) problems.push(`${at}: no option marked right`);
      (ex.options || []).forEach((o, j) => {
        if (!o.why || !o.why.trim()) problems.push(`${at}: option ${j + 1} ("${o.text}") has no explanation`);
        if (!["right", "wrong", "different"].includes(o.verdict)) problems.push(`${at}: option ${j + 1} has an unknown verdict`);
      });
    } else if (ex.type === "build") {
      if (!ex.tiles?.length || !ex.answers?.length || !ex.why) problems.push(`${at}: needs tiles, answers and why`);
      for (const a of ex.answers || []) for (const t of a) if (!ex.tiles.includes(t)) problems.push(`${at}: answer uses a tile not in tiles: ${t}`);
    } else problems.push(`${at}: reviews support choice and build drills`);
  });
  if ((b.drills || []).length < 6) problems.push(`${where}: needs at least 6 drills so reviews can vary`);
}

// Immersion picks (data/immersion/picks.json) — only the newest week is checked, so older
// weeks written under earlier rules never block a publish.
let pickWeeks = 0;
try {
  const picks = JSON.parse(await readFile(new URL("../data/immersion/picks.json", import.meta.url), "utf8"));
  pickWeeks = (picks.weeks || []).length;
  const w = (picks.weeks || [])[0];
  if (w) {
    const at = `immersion/picks.json week ${w.week}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.week || "")) problems.push(`${at}: week must be YYYY-MM-DD`);
    if ((w.picks || []).length !== 5) problems.push(`${at}: needs exactly 5 picks (has ${(w.picks || []).length})`);
    const ids = new Set();
    (w.picks || []).forEach((p, i) => {
      const pa = `${at}, pick ${i + 1}`;
      for (const k of ["id", "title", "url", "why", "listenFor"]) if (!p[k] || !String(p[k]).trim()) problems.push(`${pa}: missing ${k}`);
      if (p.url && !/^https?:\/\//.test(p.url)) problems.push(`${pa}: url must start with http`);
      if (ids.has(p.id)) problems.push(`${pa}: duplicate id ${p.id}`);
      ids.add(p.id);
      if (!["listen", "watch", "read"].includes(p.type)) problems.push(`${pa}: type must be listen, watch or read`);
      if (![1, 2, 3, 4].includes(p.level)) problems.push(`${pa}: level must be 1–4`);
      if (!Array.isArray(p.prep) || p.prep.length < 5 || p.prep.length > 8) problems.push(`${pa}: prep needs 5–8 words`);
      (p.prep || []).forEach((x, j) => { if (!x.ja || !x.en) problems.push(`${pa}: prep word ${j + 1} needs ja and en`); });
    });
    const tied = (w.picks || []).filter((p) => p.connection && String(p.connection).trim()).length;
    if (tied < 2) problems.push(`${at}: at least 2 picks need a "connection" to the week's lesson or the trip (has ${tied})`);
  }
} catch (e) {
  if (e.code !== "ENOENT") problems.push(`immersion/picks.json: can't read or parse (${e.message})`);
}

// Scenes (data/scenes/*.json, listed in data/scenes/index.json)
let sceneCount = 0;
try {
  const sdir = new URL("../data/scenes/", import.meta.url);
  const sindex = JSON.parse(await readFile(new URL("index.json", sdir), "utf8"));
  const curriculum = JSON.parse(await readFile(new URL("../data/curriculum.json", import.meta.url), "utf8"));
  const slugs = new Set(curriculum.sections.flatMap((s) => s.chapters.map((c) => c.slug)));
  const sceneIds = new Set();
  const TIERS = ["survival", "natural", "conversation", "onstage"];
  for (const entry of sindex.scenes || []) {
    const where = "scenes/" + entry.file;
    let sc;
    try {
      sc = JSON.parse(await readFile(new URL(entry.file, sdir), "utf8"));
    } catch (e) {
      problems.push(`${where}: can't read or parse (${e.message})`);
      continue;
    }
    sceneCount++;
    if (sc.id !== entry.id) problems.push(`${where}: id "${sc.id}" doesn't match index "${entry.id}"`);
    if (sceneIds.has(sc.id)) problems.push(`${where}: duplicate scene id ${sc.id}`);
    sceneIds.add(sc.id);
    for (const k of ["title", "titleEn", "situation", "tiers"]) if (!sc[k]) problems.push(`${where}: missing ${k}`);
    if (sc.when && !/^\d{4}-\d{2}-\d{2}$/.test(sc.when)) problems.push(`${where}: when must be YYYY-MM-DD`);
    if (!sc.tiers?.survival) problems.push(`${where}: needs a survival tier`);
    for (const [key, t] of Object.entries(sc.tiers || {})) {
      const at = `${where}: tier ${key}`;
      if (!TIERS.includes(key)) problems.push(`${at}: unknown tier (use ${TIERS.join(", ")})`);
      if (!Array.isArray(t.requires)) problems.push(`${at}: needs a requires list (can be empty)`);
      for (const id of t.requires || []) if (!ids.has(id)) problems.push(`${at}: requires "${id}", which isn't in the lesson index`);
      for (const slug of t.requiresChapters || []) if (!slugs.has(slug)) problems.push(`${at}: requiresChapters "${slug}" isn't a chapter in curriculum.json`);
      if (!(t.dialogue || []).length && !(t.phrases || []).length) problems.push(`${at}: has no lines`);
      (t.dialogue || []).forEach((l, i) => {
        if (!l.ja || !l.en) problems.push(`${at}: dialogue line ${i + 1} needs ja and en`);
        if (!["me", "them"].includes(l.who)) problems.push(`${at}: dialogue line ${i + 1} needs who: "me" or "them"`);
      });
      (t.phrases || []).forEach((l, i) => { if (!l.ja || !l.en) problems.push(`${at}: phrase ${i + 1} needs ja and en`); });
    }
    const vids = new Set();
    (sc.vocab || []).forEach((v, i) => {
      if (!v.id || !v.ja || !v.en) problems.push(`${where}: vocab ${i + 1} needs id, ja and en`);
      if (v.id && !/^[a-z0-9-]+$/.test(v.id)) problems.push(`${where}: vocab id "${v.id}" should be lowercase letters, numbers and dashes`);
      if (vids.has(v.id)) problems.push(`${where}: duplicate vocab id ${v.id}`);
      vids.add(v.id);
    });
  }
} catch (e) {
  if (e.code !== "ENOENT") problems.push(`scenes: can't read (${e.message})`);
}

// Vault readings (data/vault/readings.json) and burned-word sentences (data/vault/sentences.json).
let vaultReadings = 0;
try {
  const v = JSON.parse(await readFile(new URL("../data/vault/readings.json", import.meta.url), "utf8"));
  const TIERS = ["burned", "enlightened", "master", "guru"];
  const rids = new Set();
  for (const w of v.weeks || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.week || "")) problems.push(`vault/readings.json: week "${w.week}" must be YYYY-MM-DD`);
    for (const r of w.readings || []) {
      vaultReadings++;
      const at = `vault/readings.json: ${r.id || "reading with no id"}`;
      if (!r.id) problems.push(`${at}: needs an id`);
      if (rids.has(r.id)) problems.push(`${at}: duplicate id`);
      rids.add(r.id);
      for (const k of ["title", "titleEn"]) if (!r[k]) problems.push(`${at}: missing ${k}`);
      if (!(r.tiers || []).length || (r.tiers || []).some((t) => !TIERS.includes(t))) problems.push(`${at}: tiers must be some of ${TIERS.join(", ")}`);
      if (!(r.paragraphs || []).length) problems.push(`${at}: needs paragraphs`);
      (r.paragraphs || []).forEach((p, i) => { if (!p.ja || !p.en) problems.push(`${at}: paragraph ${i + 1} needs ja and en`); });
      if ((r.questions || []).length < 3) problems.push(`${at}: needs at least 3 questions`);
      (r.questions || []).forEach((q, i) => {
        const qa = `${at}: question ${i + 1}`;
        if (q.type !== "choice" || !q.prompt || !q.en) problems.push(`${qa}: needs type "choice", prompt and en`);
        if (!(q.options || []).some((o) => o.verdict === "right")) problems.push(`${qa}: no option marked right`);
        (q.options || []).forEach((o, j) => {
          if (!o.why || !o.why.trim()) problems.push(`${qa}: option ${j + 1} has no explanation`);
          if (!["right", "wrong", "different"].includes(o.verdict)) problems.push(`${qa}: option ${j + 1} has an unknown verdict`);
        });
      });
    }
  }
} catch (e) {
  if (e.code !== "ENOENT") problems.push(`vault/readings.json: can't read or parse (${e.message})`);
}
let vaultSentences = 0;
try {
  const v = JSON.parse(await readFile(new URL("../data/vault/sentences.json", import.meta.url), "utf8"));
  for (const [w, list] of Object.entries(v.words || {})) {
    for (const [i, x] of (list || []).entries()) {
      vaultSentences++;
      const at = `vault/sentences.json: ${w} #${i + 1}`;
      if (!x.ja || !x.en) problems.push(`${at}: needs ja and en`);
      else if (!/^[^«»]*«[^«»]+»[^«»]*$/.test(x.ja)) problems.push(`${at}: mark the word once with «…»`);
    }
  }
} catch (e) {
  if (e.code !== "ENOENT") problems.push(`vault/sentences.json: can't read or parse (${e.message})`);
}

// Glue (data/glue.json)
let glueCount = 0;
try {
  const g = JSON.parse(await readFile(new URL("../data/glue.json", import.meta.url), "utf8"));
  const FAM = ["filler", "listen", "link", "soft", "react"];
  const gids = new Set();
  for (const e of g.glue || []) {
    glueCount++;
    const at = `glue.json: ${e.id || "entry with no id"}`;
    if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) problems.push(`${at}: id must be lowercase romaji with dashes`);
    if (gids.has(e.id)) problems.push(`${at}: duplicate id`);
    gids.add(e.id);
    for (const k of ["ja", "does", "listen"]) if (!e[k]) problems.push(`${at}: missing ${k}`);
    if (!FAM.includes(e.family)) problems.push(`${at}: family must be one of ${FAM.join(", ")}`);
    if (!["casual", "polite", "both"].includes(e.register)) problems.push(`${at}: register must be casual, polite or both`);
    if (!(e.examples || []).length) problems.push(`${at}: needs at least one example`);
    (e.examples || []).forEach((x, i) => {
      if (!x.ja || !x.en) problems.push(`${at}: example ${i + 1} needs ja and en`);
      else if (!/^[^«»]*«[^«»]+»[^«»]*$/.test(x.ja)) problems.push(`${at}: example ${i + 1} must mark the word once with «…»`);
    });
  }
  for (const [hid, a] of Object.entries(g.answered || {})) {
    if (!hid.startsWith("hrd:")) problems.push(`glue.json answered: key ${hid} should be a hrd: id`);
    if (!a.answer) problems.push(`glue.json answered ${hid}: needs an answer`);
    if (a.glue && !gids.has(a.glue)) problems.push(`glue.json answered ${hid}: glue "${a.glue}" isn't an entry`);
  }
} catch (e) {
  if (e.code !== "ENOENT") problems.push(`glue.json: can't read or parse (${e.message})`);
}

// Japanese definitions for Deep mode (data/vault/defs.json): only kanji he knows, no giveaways.
let defCount = 0;
try {
  const defs = JSON.parse(await readFile(new URL("../data/vault/defs.json", import.meta.url), "utf8")).defs || {};
  let known = null;
  try {
    known = new Set([...(JSON.parse(await readFile(new URL("../data/wk-state.json", import.meta.url), "utf8")).knownKanji || "")]);
  } catch {}
  for (const [w, d] of Object.entries(defs)) {
    defCount++;
    const at = `vault/defs.json: ${w}`;
    if (!d || !String(d).trim()) problems.push(`${at}: empty definition`);
    const bare = w.replace(/〜/g, "");
    if (bare && String(d).includes(bare)) problems.push(`${at}: the definition contains the word itself`);
    if (/[{}|]/.test(d)) problems.push(`${at}: no furigana markup; write unknown kanji in kana`);
    if (known && known.size) {
      const odd = [...String(d)].filter((c) => /[一-龯]/.test(c) && !known.has(c));
      if (odd.length) problems.push(`${at}: kanji he doesn't know yet (${[...new Set(odd)].join("")}); write them in kana`);
    }
  }
} catch (e) {
  if (e.code !== "ENOENT") problems.push(`vault/defs.json: can't read or parse (${e.message})`);
}

if (problems.length) {
  console.error(problems.map((p) => "✕ " + p).join("\n"));
  process.exit(1);
}
console.log(`✓ ${index.lessons.length} lessons and ${bankCount} review banks, every answer explained.${sceneCount ? ` Scenes: ${sceneCount}.` : ""}${glueCount ? ` Glue: ${glueCount}.` : ""}${vaultReadings ? ` Vault: ${vaultReadings} readings, ${vaultSentences} sentences, ${defCount} definitions.` : ""}${pickWeeks ? ` Picks: ${pickWeeks} week(s), newest OK.` : ""}`);
