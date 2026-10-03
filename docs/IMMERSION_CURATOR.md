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

If a pick ties to this week's grammar point or to an upcoming trip situation (trains, inns,
food, music), say so in `why`.

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
- `prep`: 5–8 words worth knowing *before* starting, chosen from what the episode is likely about
  (title, show notes, description). Use `{漢字|かな}` markup; prefer words with kanji he knows
  (`data/wk-state.json`) plus the few genuinely new ones the content needs.
- Write titles as published. Don't copy show notes or transcripts beyond a few words; `why` is
  your own words.

## Check and publish

Validate the JSON (`node -e "JSON.parse(require('fs').readFileSync('data/immersion/picks.json','utf8'))"`),
then commit with the lesson work (or alone: `Immersion picks: week of 2026-10-12`) and push.
Mention the picks in your end-of-run summary.
