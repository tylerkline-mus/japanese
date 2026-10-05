# Weekly lesson writer — instructions

You are writing next week's grammar material for this Japanese hub. The learner is an adult
(WaniKani level ~10) preparing for an extended stay in Japan: an artist residency, solo rail
travel with small inns, rehearsals with musicians, field recording, and dinners with friends.
He's a composer and radio producer (not a performer). His goal is *thinking* in Japanese, not translating.
The run instructions may add more personal context — use it, but never write it into the repo.

## 1. Read the current state

- `data/lessons/index.json` — lessons that exist, in order.
- `data/curriculum.json` — Tae Kim's order. The next lesson is the next chapter after the last
  one that has a `lesson` field. Some chapters can be combined or skipped if already covered.
- `data/wk-state.json` — his Guru+ kanji (`knownKanji`) and current leeches. If missing, assume
  WaniKani levels 1–10 kanji.
- `data/wk-vocab.json` — every WaniKani word he's started: `{words:[{w, r, m, s, l}]}` (word,
  reading, meaning, SRS stage, level). `s >= 5` = Guru or higher = he knows it. This is the main
  vocabulary source for sentences.
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
- **Vocabulary: build sentences from words he knows.** Aim for every content word (nouns, verbs,
  adjectives) to be a `s >= 5` word in `wk-vocab.json`, or a very common kana word. Allow at most
  **one new word per sentence**, and only when the situation needs it. Prefer his recent WaniKani
  words (`l` close to his current level, `s` 5–6) so lessons reinforce what he's learning now.
  Work in 1–2 of his current leeches per lesson where they fit naturally.
- Markup: put `{漢字|かな}` on every kanji word. The hub hides furigana for words and kanji he knows,
  so marking everything is free. Mark whole words where possible (`{電車|でんしゃ}`, not per kanji),
  and for okurigana words mark each kanji chunk (`{乗|の}り{換|か}え`) — the hub still recognizes the word.
- Use his real situations where they fit (calling for a pickup at a station, inns, rehearsals,
  recording, ordering, dinner with friends, a partner visiting). Don't force it. Generic place
  and people names in sentences are fine; don't add private details beyond what's already in the repo.
- English is the meaning, not a word-for-word gloss.
- Japanese-first: the hub hides English behind a tap, so prompts should be answerable from the
  Japanese plus the scene.

## 4. Scenes (every run)

Scenes live in `data/scenes/<id>.json`, listed in `data/scenes/index.json`. Copy the shape of
`data/scenes/about-me.json`. Each scene has tiers that open as lessons are marked done:
`survival` (works now, `requires: []`), `natural`, `conversation`, `onstage` (a short spoken piece).
A tier's `requires` lists lesson ids that exist; `requiresChapters` lists Tae Kim chapter slugs
from `data/curriculum.json` that don't have a lesson yet. The hub opens a tier when all of both are done.

Do these in order, and keep the total small (a scene a week is plenty):

1. **Requests.** If the run instructions include a sync key, fetch
   `<syncUrl>?action=requests&key=<key>` with WebFetch. Each open request is `{row, request, notes}`.
   Turn each one into a new scene or a new tier of an existing scene. Then mark it handled with
   `<syncUrl>?action=resolve&key=<key>&row=<row>&status=<URL-encoded short note, e.g. "Added 2026-10-11: new scene, Sake bar">`.
   If the fetch fails, say so in the summary and carry on.
2. **Grow with the grammar.** If you wrote a new lesson this run, pick one or two scenes where that
   grammar would make a line more natural. Add lines to the tier that should hold them, or add a
   `natural`/`conversation` tier that `requires` the new lesson. When a chapter in a tier's
   `requiresChapters` gets its lesson, move it to `requires` as the lesson id.
3. **Fill thin scenes.** If neither of the above gave you anything to do, add a `natural` tier to
   the scene with the nearest `when` date that only has `survival`.

Scene rules:
- Every line has `ja` and `en`; dialogue lines have `who`: `"me"` or `"them"`. "Them" lines can use
  grammar beyond his level (he only needs to understand them); "me" lines should fit the tier's grammar.
- Polite です/ます for his lines. Same `{漢字|かな}` markup as lessons.
- `vocab`: only words the scene needs, `{id, ja, en, note}`, ids lowercase romaji, unique per scene.
  Leave out words already in `wk-vocab.json`.
- `when`: the date the hub should start showing the scene. Use dates from the itinerary in the run
  instructions, but **no names of people** in scene files; the repo is public.
- Never rewrite a scene's lines just for style. He's memorizing them.

## 5. Vault (every run)

The Vault keeps words he already knows from WaniKani alive. Tiers come from `data/wk-vocab.json`
stages: `burned` (s = 9), `enlightened` (8), `master` (7), `guru` (5–6). Burned words matter most:
WaniKani never shows them again.

1. **Readings.** Add a new week to the **front** of `data/vault/readings.json` with **3 readings**.
   Copy the shape of the existing ones: `id` (`rNNN-slug`, numbered after the highest), `title`,
   `titleEn`, `kind` (diary, travel story, menu, note from a friend, sign, short dialogue…),
   `tiers`, `paragraphs` ({ja, en}, 4–7 short ones), `questions` (3–4 `choice` questions; every option
   has `verdict` and `why`, same rule as lessons). Rotate tiers across the week: at least one reading
   built mainly from **burned** words, one from **enlightened**, one mixing master/guru.
   - Content words come from his WaniKani words in the reading's tiers (or lower-stage words he
     knows, `s >= 5`). At most one new word per paragraph, and give it furigana.
   - Grammar: only lessons he has done plus polite です/ます basics. Short sentences.
   - Prefer burned words he hasn't seen lately: `data/grammar-progress.json` includes rows with ids
     `brn:<word>`; `seen` is the date he last refreshed it. Never-seen and oldest-seen first.
     Words with `wrong > 0` deserve a reappearance.
   - Use his world where it fits (trains, inns, food, music, Kentucky, a cat), no private names.
2. **Sentences.** Add 20–30 entries to `data/vault/sentences.json` for burned words that don't have
   one yet (same priority as above). One natural sentence each, `{ja, en}`, with the burned word
   wrapped once in «…» inside the `ja` (e.g. `{少|すこ}し«{休|やす}み»ましょう。`). Other words: ones he knows.
   A word can have more than one sentence; the hub rotates through them.

## 6. Glue (every run)

`data/glue.json` holds the small spoken words: fillers, listening sounds (あいづち), linkers,
softeners and sentence endings, reactions. Copy an existing entry's shape: `id` (romaji),
`ja`, `family` (`filler` | `listen` | `link` | `soft` | `react`), `does` (its job in one line,
in plain English: what it does, not a dictionary gloss), `register`, `examples` (2, each with the
word marked once with «…» in `ja`), `listen` (where he'll hear it), optional `note`.

1. **Heard it.** `data/grammar-progress.json` has rows with ids `hrd:<…>`; `seen` is what he heard
   (often romaji or a guess), sometimes followed by ` ␟ ` and where he heard it. For each one not
   already a key in `answered`, work out what it most likely was. Add
   `answered["hrd:…"] = {answer, glue}`: `answer` is 1–3 plain sentences (what it is, what it does,
   the likely spelling); `glue` is the id of the entry you added or matched, or null if it isn't a
   glue word (then say what it is: vocabulary, a name, a song lyric, and so on).
2. **Grow the list.** Add 2–3 new entries a week until the common core is covered (けっこう, ほら,
   あれ？, ねえ, さあ, もう, まだ, ちゃんと, ぜひ, どうも, なんだか, っていうか, わけ, のに, もの…).
   Each new `does` must be clearly different from existing ones.
3. Example lines: short, natural, his level, polite or casual matching `register`.

## 7. Check and publish

1. `node scripts/validate-lessons.mjs` must pass. Fix anything it reports.
2. Re-read every Japanese sentence once more for naturalness and correctness. If unsure about one,
   replace it with a simpler sentence you're sure of.
3. Commit with a message like `Lesson 4: 〜たい (wanting)`, `Review sentences: +4 は/が` or `Scenes: natural tier for Ordering food`, or one commit for everything, e.g. `Week 2: lesson, 3 vault readings, 24 sentences` and push to `main`.
4. End with a 2–3 line summary: what you added (lesson, reviews, scenes, vault readings and sentences), why (caught up or not, what
   was shaky, which requests), and anything you couldn't read.

## Direction notes from Tyler

(Edit this section to steer the course.)

- **Everything reinforces, and everything pushes him to think in Japanese.** A guide he has to
  remember to open doesn't count. Whatever you write should reuse what he already has:
  - Lesson and review sentences use his scene lines, glue words and recently burned words where they
    fit naturally, not just new material.
  - Vault readings work in 2–3 glue words each (dialogue is a good place), and scenes' natural and
    conversation tiers should use glue (えっと, そうなんですね, じゃあ, やっぱり) the way real speech does.
  - Prompts and question stems in Japanese wherever his level allows; English is the fallback
    behind a tap, not the default.
  - Prefer exercises where he produces or reacts (say it, answer the line, what is this word doing)
    over recognize-and-tick.
- Keep the pace gentle while he digs out of the WaniKani backlog (Oct–early Nov 2026).
- Prioritize grammar he'll use in real conversations on the trip over literary forms.
