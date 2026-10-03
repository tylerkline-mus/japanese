# Weekly lesson writer — instructions

You are writing next week's grammar material for this Japanese hub. The learner is an adult
(WaniKani level ~10) preparing for an extended stay in Japan: an artist residency, solo rail
travel with small inns, rehearsals with musicians, field recording, and dinners with friends.
He's a cellist and composer. His goal is *thinking* in Japanese, not translating.
The run instructions may add more personal context — use it, but never write it into the repo.

## 1. Read the current state

- `data/lessons/index.json` — lessons that exist, in order.
- `data/curriculum.json` — Tae Kim's order. The next lesson is the next chapter after the last
  one that has a `lesson` field. Some chapters can be combined or skipped if already covered.
- `data/wk-state.json` — his Guru+ kanji (`knownKanji`) and current leeches. If missing, assume
  WaniKani levels 1–10 kanji.
- `data/history.json` — daily WaniKani stats (queue, accuracy). Context only.
- `data/grammar-progress.json` — grammar review progress, refreshed nightly from the Sheet:
  `{items:[{id, stage, due, right, wrong}]}`. `stage >= 1` means he marked that lesson done.
  If the file is missing or more than 3 days old, and the run instructions include a sync key,
  try `<syncUrl from data/config.json>?action=get&key=<key>` with WebFetch. If neither works,
  say so in your summary and use the fallback rule below.

## 2. Decide what to write

- **New lesson only if he's caught up**: every existing lesson has `stage >= 1`.
  Fallback when progress can't be read: write a new lesson only if the newest lesson's `week`
  is at or before the current course week (weeks count from `courseStart` in `data/config.json`).
- **Otherwise, no new lesson.** A missed week never creates a backlog.
- **Every run**: add 3–5 fresh drills to the review bank of any point that is shaky
  (`wrong / (right + wrong) > 0.25` with at least 6 answers, or stage stuck at 1–2), aimed at
  the specific confusion. If nothing is shaky, add 2–3 drills to the two lowest-stage points
  so reviews keep varying. Never duplicate an existing sentence.

## 3. Write it

Copy the shape of `data/lessons/02-ni-de.json` and `data/grammar/02-ni-de.json` exactly.

A new lesson = two files plus an index entry:
- `data/lessons/NN-slug.json` (id = `NN-slug`, `week` = previous week + 1)
- `data/grammar/NN-slug.json` with **10–12 drills** (`choice` and a few `build`), all
  different from the lesson's own exercises. Drill ids: short prefix + number, unique in the file.
- Append `{id, file, week, title, titleEn}` to `data/lessons/index.json`.
- Add `"lesson": "NN-slug"` to the matching chapter in `data/curriculum.json`.

Rules (non-negotiable):
- **Every choice option has `verdict` (`right` / `wrong` / `different`) and a `why`.** `different`
  = grammatical but means something else; say what it would mean. This is the whole point of the
  hub — explain *why*, especially the subtle ones.
- Explanations: plain language, the *mechanism* behind the rule, short paragraphs, `**bold**` for
  the key idea. Contrast pairs teach the subtle differences head-on.
- Japanese: natural, correct, and mostly built from `knownKanji`. Any kanji outside that set gets
  `{漢字|かな}` markup. Put markup on every kanji word anyway — the hub hides furigana he doesn't need.
- Work in 1–2 of his current leeches per lesson where they fit naturally.
- Use his real situations where they fit (calling for a pickup at a station, inns, rehearsals,
  recording, ordering, dinner with friends, a partner visiting). Don't force it. Generic place
  and people names in sentences are fine; don't add private details beyond what's already in the repo.
- English is the meaning, not a word-for-word gloss.
- Japanese-first: the hub hides English behind a tap, so prompts should be answerable from the
  Japanese plus the scene.

## 4. Check and publish

1. `node scripts/validate-lessons.mjs` must pass. Fix anything it reports.
2. Re-read every Japanese sentence once more for naturalness and correctness. If unsure about one,
   replace it with a simpler sentence you're sure of.
3. Commit with a message like `Lesson 4: 〜たい (wanting)` or `Review sentences: +4 は/が` and push to `main`.
4. End with a 2–3 line summary: what you added, why (caught up or not, what was shaky), and anything
   you couldn't read.

## Direction notes from Tyler

(Edit this section to steer the course.)

- Keep the pace gentle while he digs out of the WaniKani backlog (Oct–early Nov 2026).
- Prioritize grammar he'll use in real conversations on the trip over literary forms.
