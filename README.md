# AIM charity directory

Embeddable "our charities" directory for the Ambitious Impact (AIM) Squarespace site, fed from the **AIM Website Content** Airtable base.

```
Airtable (Website + Website Founders)
   │  scripts/build.mjs  — nightly GitHub Action + manual dispatch
   ▼
public/charities.json + public/img/**   — deployed to GitHub Pages
   │
   ▼
Squarespace code block snippet — renders an inline snapshot instantly,
then fetches the live JSON and re-renders only if it changed
```

## Layout

| Path | What |
| --- | --- |
| `config/publish.json` | Base/table IDs, publish rules, **field allowlist**, agreed cause tags |
| `data/continents.json` | Country → continent lookup (owned here, not in Airtable) |
| `assets/logos/`, `assets/founders/` | Logos and founder photos committed to the repo (see *Images* below) |
| `scripts/import-images.mjs` | One-off importer: matches a folder of processed images to charities/founders and copies them into `assets/` |
| `config/image-import-overrides.json` | Manual fixes for the importer (swapped names, files to skip) |
| `scripts/build.mjs` | Pull Airtable → transform → rehost images → `public/charities.json` |
| `scripts/lib/` | `airtable.mjs` (REST client), `transform.mjs` (pure transform), `images.mjs` (rehosting) |
| `scripts/verify-allowlist.mjs` | Fails if the published JSON contains anything outside the allowlist |
| `scripts/make-snippet.mjs` | Builds `public/snippet.html` (the Squarespace code block: widget + inline data snapshot + live URL) and `public/demo.html` (self-contained preview) |
| `public/widget.css`, `public/widget.js` | The widget itself: dependency-free, every style scoped under `.aim-dir` |
| `public/index.html` | Preview page that fetches `charities.json` (add `?bleed=1` for the theme-bleed stress test) |
| `public/` | Everything that gets deployed to GitHub Pages (`charities.json` tracked; images, snippet and demo are build outputs) |
| `.github/workflows/build.yml` | Nightly / manual / on-push build and Pages deployment |
| `design/` | Figma exports (desktop + mobile) |

## Running the build locally

The Airtable personal access token (read-only, scoped to this one base) is read from the `AIRTABLE_TOKEN` environment variable and nowhere else. Never commit it, never paste it into chat, never echo it.

One-time setup on your Mac: add `export AIRTABLE_TOKEN="..."` to `~/.zprofile` (not `~/.zshrc`, which non-interactive shells such as Claude Code's don't read). New terminal windows pick it up automatically.

In GitHub Actions the same value lives in the repository secret **`AIRTABLE_TOKEN2`**, which the workflow maps to the `AIRTABLE_TOKEN` environment variable.

```bash
export AIRTABLE_TOKEN=...      # in your own shell only
npm run build                  # writes public/charities.json and public/img/**
npm run verify                 # allowlist check on the output
npm run preview                # http://localhost:8787/  (add ?data=/preview-data/charities.json for the design fixture)
```

Useful flags for `scripts/build.mjs`:

- `--skip-images` — don't download attachments (logo/photo fields become `null`, never an expiring Airtable URL)
- `--dump-raw DIR` — also write the raw Airtable records to `DIR` (gitignored `raw/`); handy for debugging
- `--from-raw DIR` — build from a previous raw dump instead of calling Airtable
- `--out DIR` — output directory (default `public`)
- `--ignore-ready` — **design preview only**: drop the *Website ready?* requirement (Undercover?, Exclude and Status still apply) and write to `design/preview-data/` instead of `public/`. Used while logos/photos are still being added so the widget can be designed against real rows.

## Images

Each logo or founder photo comes from one of two places, in this order:

1. **An Airtable attachment** on the row (`Logo` on Website, `Photo` on Website Founders). The build downloads it at build time because Airtable attachment URLs expire within hours.
2. **A file in this repo**, used when the row has no attachment:
   - `assets/logos/<charity id>.webp` — the charity id is the `id` in `public/charities.json`, e.g. `assets/logos/animal-ask.webp`
   - `assets/founders/<charity id>/<founder slug>.webp` — the founder's name slugified, e.g. `assets/founders/animal-ask/amy-odene.webp`
   - `.png`, `.svg`, `.jpg` and `.avif` also work.

Either way the build copies the file to `public/img/...` under a content-hashed name, so browsers never show a stale image. The build lists every published charity without a logo and every founder without a photo, and every repo asset that no published row uses (usually a renamed charity or a typo).

To bulk-import a folder of processed images laid out as `<year>/<charity>/<files>`:

```bash
node scripts/import-images.mjs "/path/to/cropped and compressed"          # dry run: prints the matching report
node scripts/import-images.mjs "/path/to/cropped and compressed" --apply  # copies matched files into assets/
```

Fix anything the report flags in `config/image-import-overrides.json`, then re-run. Founder photos are recognised by name (accents, nicknames and small typos are tolerated) and by shape (512×512 headshots); wide images are treated as logos.

## Publishing rules

A charity is published only when **Website ready?** is ticked, **Undercover?** and **Exclude from website** are unticked, and **Status** is Active, Shutdown or Merged. The build applies these in the Airtable filter formula *and* re-checks them in code. Only the fields listed in `config/publish.json → allowlist` are ever read from the API or written to the output. A blurb may contain links written as `[text](https://example.org)`; the widget renders them as links and shows everything else as plain text. Founders are published only for published charities; their **LinkedIn** field (a URL on Website Founders) turns the founder's name into a link, and anything that isn't a linkedin.com URL is dropped with a warning.

## Deployment

`.github/workflows/build.yml` runs every night at 03:17 UTC, on every push to `main`, and on demand (Actions tab → *Build and deploy directory* → *Run workflow*). It pulls Airtable with the repository secret **`AIRTABLE_TOKEN2`**, builds `public/`, runs the allowlist check, generates the snippet, commits a changed `public/charities.json` back to `main`, and deploys `public/` to GitHub Pages:

| URL | What |
| --- | --- |
| https://aidan-alexander.github.io/aim-charity-directory/ | Preview page with the live data |
| https://aidan-alexander.github.io/aim-charity-directory/charities.json | The JSON the widget refreshes from |
| https://aidan-alexander.github.io/aim-charity-directory/snippet.txt | The Squarespace code-block content as plain text, regenerated every build: open, select all, copy, paste into the code block |
| https://aidan-alexander.github.io/aim-charity-directory/demo.html | Self-contained demo of exactly what the code block renders |

`public/img/`, `public/snippet.html` and `public/demo.html` are build outputs and are not tracked in git; `public/charities.json` is tracked so the widget can be developed locally without an Airtable token. The Pages base URL lives in `config/publish.json → pagesBaseUrl`; if the repo is ever transferred or renamed, change it there and re-paste the snippet.

Images are re-encoded at build time (`config/publish.json → images`): logos have uniform borders trimmed and are fitted inside 480×240, founder photos become 160×160 squares, everything except SVG becomes WebP.

_Token rotation and repo transfer notes are completed in the wrap-up phase._
