# 日本語 · Japanese Hub

A personal Japanese study hub. Static site on GitHub Pages — no server, nothing to maintain.

- **Today** — today's review number (a gentle dig-out plan), lesson of the week, a self-talk prompt, tricky items.
- **Stats** — queue burn-down, SRS breakdown, days you showed up, forecast, accuracy, level pace, kanji coverage, trip readiness, leeches.
- **Course** — Tae Kim's order, with lessons written here: plain explanations, contrast pairs, and practice where every answer explains itself.
- **Phrases** — real trip moments, Japanese first.
- **Notes** — everything from the published Google Sheet, searchable.

## How the pieces connect

| Source | Job | How |
|---|---|---|
| WaniKani API | what you know | read live in your browser with your token (stored on your device only) |
| Google Sheet (published CSV) | your notes | read live; columns `Japanese, Reading, English, Notes, Tags` |
| `data/lessons/*.json` | the course | one file per lesson, listed in `data/lessons/index.json` |
| `data/history.json` | stats over time | written every evening by the **Daily snapshot** Action |

Japanese markup: `{漢字|かんじ}` gives a word its reading. Kanji you've reached Guru on in WaniKani show plain; anything else gets furigana. Tap any kanji for its meaning and your WaniKani stage.

## Grammar reviews (SRS)

Marking a lesson done adds that grammar point to your reviews. Each review shows 3 different sentences from `data/grammar/<lesson id>.json`, mixed with other due points. All right → step up; one miss → same step; more → step back. Steps are 1, 3, 7, 14, 30, 90 days, then retired. At most 4 points (~12 sentences) a day, so nothing piles up.

Progress syncs through your Google Sheet via the Apps Script in `apps-script/Code.gs` (it writes to an `srs` tab). Without it, progress stays on the device.

## Setup

1. **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
2. **Settings → Secrets and variables → Actions**: secret `WANIKANI_TOKEN` (read-only token) for the daily snapshot.
3. Open the site, go to Settings (gear), paste the same token once per device.

Preview without a token: add `?demo` to the URL.

## Rules the lessons follow

- Every multiple-choice option has a `verdict` (`right`, `wrong`, or `different` — grammatical but means something else) and a `why`. The **Check lessons** Action fails if any explanation is missing, and the hub hides any exercise that slips through.
- A missed week never piles up. The next lesson is just the next lesson.
