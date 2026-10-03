// Nightly: read podcast feeds listed in data/immersion/sources.json and add new episodes
// to data/immersion/archive.json. Links and short show-note snippets only — no content copied.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const dir = new URL("../data/immersion/", import.meta.url);
const read = async (f, fallback) => {
  try {
    return JSON.parse(await readFile(new URL(f, dir), "utf8"));
  } catch {
    return fallback;
  }
};
const write = (f, v) => writeFile(new URL(f, dir), JSON.stringify(v, null, 1) + "\n");

const { sources } = await read("sources.json", { sources: [] });
const resolved = await read("resolved.json", {});
const archive = await read("archive.json", []);
const byId = new Map(archive.map((a) => [a.id, a]));
const UA = { "User-Agent": "japanese-hub/1.0 (personal study feed reader)" };
const PER_SOURCE = 12;
const MAX_ARCHIVE = 2000;

async function itunes(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Apple lookup ${res.status}`);
  return (await res.json()).results || [];
}

async function resolveFeed(src) {
  if (src.feedUrl) return src.feedUrl;
  if (resolved[src.key]?.feedUrl) return resolved[src.key].feedUrl;
  if (src.id) {
    const r = await itunes(`https://itunes.apple.com/lookup?id=${src.id}&entity=podcast`);
    if (r[0]?.feedUrl) return r[0].feedUrl;
  }
  if (src.term) {
    const re = new RegExp(src.match || ".", "i");
    const ex = src.exclude ? new RegExp(src.exclude, "i") : null;
    for (const country of [src.country || "us", "jp"]) {
      const r = await itunes(`https://itunes.apple.com/search?media=podcast&limit=15&country=${country}&term=${encodeURIComponent(src.term)}`);
      const hit = r.find((x) => x.feedUrl && re.test(x.collectionName || "") && !(ex && ex.test(x.collectionName || "")));
      if (hit) return hit.feedUrl;
    }
  }
  return null;
}

const decode = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&");
const strip = (s) =>
  decode(s)
    .replace(/<\/?(b|i|em|strong|span|a|ruby|rt|rp|u|small)(\s[^>]*)?>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
};
const attr = (block, name, a) => {
  const m = block.match(new RegExp(`<${name}\\s[^>]*${a}="([^"]+)"`, "i"));
  return m ? decode(m[1]) : "";
};
function minutes(d) {
  if (!d) return null;
  const s = strip(d);
  if (/^\d+$/.test(s)) return Math.round(+s / 60);
  const p = s.split(":").map(Number);
  if (p.some(isNaN)) return null;
  const secs = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
  return Math.max(1, Math.round(secs / 60));
}

export function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  return blocks.map((b) => {
    const link = strip(tag(b, "link")) || attr(b, "link", "href");
    const audio = attr(b, "enclosure", "url");
    const date = strip(tag(b, "pubDate"));
    const summary = strip(tag(b, "itunes:summary") || tag(b, "description") || tag(b, "content:encoded"));
    return {
      title: strip(tag(b, "title")),
      url: link || audio,
      audio: audio || null,
      date: date && !isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
      minutes: minutes(tag(b, "itunes:duration")),
      summary: summary.length > 160 ? summary.slice(0, 157) + "…" : summary,
    };
  });
}

async function main() {
  const status = [];
  let added = 0;
  for (const src of sources) {
    try {
      const feedUrl = await resolveFeed(src);
      if (!feedUrl) throw new Error("couldn't find the feed");
      resolved[src.key] = { feedUrl, name: src.name, checked: new Date().toISOString() };
      const res = await fetch(feedUrl, { headers: UA });
      if (!res.ok) throw new Error(`feed ${res.status}`);
      const items = parseFeed(await res.text())
        .filter((i) => i.title && i.url)
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
        .slice(0, src.perNight || PER_SOURCE);
      let n = 0;
      for (const it of items) {
        const id = createHash("sha1").update(it.url + "|" + it.title).digest("hex").slice(0, 12);
        if (byId.has(id)) continue;
        byId.set(id, { id, source: src.key, sourceName: src.name, type: "listen", level: src.level, tags: src.tags || [], ...it, added: new Date().toISOString() });
        n++;
      }
      added += n;
      status.push(`✓ ${src.name}: ${items.length} recent, ${n} new`);
    } catch (e) {
      status.push(`✕ ${src.name}: ${e.message}`);
    }
  }

  const out = [...byId.values()].sort((a, b) => (b.date || b.added).localeCompare(a.date || a.added)).slice(0, MAX_ARCHIVE);
  await write("archive.json", out);
  await write("resolved.json", resolved);
  console.log(status.join("\n"));
  console.log(`Archive: ${out.length} episodes (${added} new).`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
