# Weekly immersion curator — instructions

Every Sunday, after the lesson work in `LESSON_WRITER.md`, pick **5 things to listen to or watch
this week** and add them to `data/immersion/picks.json`. Five, not more: this list should feel
doable, never like another queue.

## What he wants

- Mostly **listening**: podcasts and interviews. Some YouTube is welcome.
- **Interviews and talk**, ideally about music, sound, art, travel, or daily life in Japan.
  He's a composer and cellist who does field recording and produces radio — content he'd enjoy
  in English is the most sustainable kind.
- **NHK-FM 「現代の音楽」** (contemporary music, composer guests) is a priority when a recent
  episode or program page can be found via search. Note that NHK streams may be region-limited.
- Level: WaniKani ~10. Mix it: 3 learner-friendly (level 1–2), 1–2 native (level 3–4).

## Where to look

1. `data/immersion/archive.json` — podcast episodes the nightly job already pulled from
   `sources.json` (learner podcasts + NHK radio). Prefer these: links are known-good.
   Reference them with `"fromArchive": "<archive id>"`.
2. WebSearch for the rest: interviews, YouTube (channels like Comprehensible Japanese, Onomappu,
   YUYUの日本語 are good starting points), music programs. Only include a link you actually saw
   in a search result or fetched page. Some sites (including nhk.or.jp) can't be fetched — a link
   from search results is fine; never try to work around a blocked site.
3. `data/grammar-progress.json` items whose ids start with `imm:` are things he marked done
   (`right` = minutes). Don't re-pick them, and lean toward sources he actually finishes.

## Tie it to what he's studying

- Find **this week's grammar point**: the lesson in `data/lessons/index.json` whose `week` matches
  the coming week (counted from `courseStart` in `data/config.json`), or the newest lesson he
  hasn't marked done (`data/grammar-progress.json`). Also note any grammar point that's shaky.
- **At least 2 of the 5 picks must have a `connection`**: one short sentence on how it ties to
  this week's grammar point, a recent WaniKani word cluster, or an upcoming trip situation
  (trains, inns, food, music, field recording). Choose those picks *for* that tie — by topic,
  from titles and show notes.
- **Every pick gets a `listenFor`**: one concrete, doable thing to listen for that practices this
  week's grammar point (or a shaky one) in *any* audio, plus a hook into the content if you can.
  You can't hear the episode, so don't claim a specific sentence is in it — give a task that works
  regardless. Good: "Every time you hear **で** after a place, ask: what's happening there?"
  Bad: "Notice when she says 駅で待っています at 3:20."

## Prep words

5–8 words per pick, chosen from what the episode is likely about (title, show notes, description).
Use `data/wk-vocab.json`:
- Prefer words he already has at `s >= 5` — the hub marks them "from WaniKani", and recognizing
  known words in real audio is the confidence win.
- Include the 2–4 genuinely new words the content needs. Don't pad with easy words he obviously knows.
- Write `ja` with `{漢字|かな}` markup and the dictionary form; `en` is a short gloss.

## Format

Add a new week at the **front** of `weeks` (week = the coming Monday, YYYY-MM-DD):

```json
{
  "week": "2026-10-12",
  "note": "One short line on the week's theme.",
  "picks": [
    {
      "id": "w2026-10-12-1",
      "title": "Episode or video title as published",
      "url": "https://…",
      "type": "listen",
      "source": "Nihongo con Teppei",
      "minutes": 12,
      "level": 1,
      "why": "One or two sentences: why this, why now.",
      "connection": "Ties to this week's に vs で — it's all about getting around by train. (required on at least 2 picks)",
      "listenFor": "Every で after a place: what's happening there? Every に: arriving, or just being there?",
      "prep": [
        { "ja": "{電車|でんしゃ}", "en": "train" },
        { "ja": "{乗|の}り{換|か}え", "en": "transfer" }
      ],
      "tags": ["trains", "travel"],
      "fromArchive": "optional archive id"
    }
  ]
}
```

- `type`: `listen`, `watch`, or `read`. `level`: 1 learner-slow · 2 learner-natural · 3 native · 4 native-dense.
- Write titles as published. Don't copy show notes or transcripts beyond a few words; `why` is
  your own words.

## Check and publish

Run `node scripts/validate-lessons.mjs` — it checks the newest week (5 picks, listenFor on each,
5–8 prep words, at least 2 connections, valid links). Fix anything it reports, then commit with the lesson work (or alone: `Immersion picks: week of 2026-10-12`) and push.
Mention the picks in your end-of-run summary.
