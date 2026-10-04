# Scenes — plan (built 2026-10-04)

Replace the static Phrases tab with **Scenes**: real situations that grow with the learner,
practiced actively, with their own vocabulary track. Agreed with Tyler on 2026-10-03.

## The 8 starting scenes (priority order)

1. **About me** — name, where from (Louisville, Kentucky), what I do (composer, radio
   producer/host), why I'm in Japan (composer residency at a studio near Fukuoka, a solo exhibition,
   concerts in Tokyo), and that I just came from an artist residency in Iceland. Most custom vocab.
2. **Ordering food** — counters, set meals, おすすめ, dislikes, paying.
3. **Inn check-in** — reservation, meals, bath times, luggage, checkout, room-only vs. meals.
4. **Pickup call** — calling the studio from a rural station.
5. **Asking permission** — photos, video, field recording; polite asking and recognizing an indirect "no".
6. **Rehearsal** — bars/measures, tempo, dynamics, from the top, small talk with musicians.
7. **Trains and tickets.**
8. **Dinner as a guest** at a friend's family home.

## Shape of a scene (data/scenes/<id>.json)

- `title`, `situation` (one line), `when` (date the hub should start surfacing it — use the
  itinerary in the private task context; keep only dates in the repo, no names), `register` notes.
- `tiers`: `survival` (works now), `natural` (unlocks when listed grammar lessons are done),
  `conversation` (small talk beyond the transaction), optional `onstage` (a short spoken piece).
  Each tier: `requires` (lesson ids), optional `requiresChapters` (Tae Kim slugs without a lesson yet),
  `dialogue` (lines with `who`: "me" | "them", `ja` with {漢字|かな} markup, `en`), `phrases`.
- `vocab`: scene words `{id, ja, en, note}`. Words already in data/wk-vocab.json show as
  "from WaniKani" instead of being reviewed twice.

## Practice

- **Prompted recall** ("The driver asks where you are. What do you say?") → say it aloud → reveal model.
- **Listen and respond**: play a "them" line via speech synthesis, text hidden, answer, reveal.
- **Practice with Claude**: button copies a role-play prompt (scene, his level, known grammar, ask for
  gentle corrections after) for Claude voice mode.
- **Scene vocab SRS**: reuse assets/srs.js with ids `voc:<scene>:<word>`, synced through the Sheet;
  daily cap small (~10). Stats line for scene vocab.

## Growth

- Tiers unlock as grammar lessons are marked done (grammar-progress / srs state).
- Today surfaces scenes as their `when` date approaches.
- Sheet tab **"Scene requests"** (columns: Request, Notes) — the Sunday writer turns new requests
  into scenes or tier additions. Add a section to docs/LESSON_WRITER.md for this.
- Validator: every dialogue line has ja + en; every tier lists requires; vocab ids unique.

## Keep

- Japanese-first everywhere; furigana per WaniKani words/kanji (renderJa with S.known, S.words).
- Phrases tab becomes the searchable phrasebook ("Scenes"), usable as a reference on the trip.
- Existing data/phrases.json content folds into the matching scenes.
