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

Logos and founder photos live in Airtable: the `Logo` attachment on the Website table and the `Photo` attachment on Website Founders. To change one, drop the new file into the cell; the next build downloads it, trims and resizes it, and publishes it to GitHub Pages under a content-hashed name (so browsers never show a stale image). Airtable attachment URLs expire within hours, which is why the build rehosts them.

Guidance for good results: logos as PNG, SVG or WebP with a transparent or white background, at least 500 px wide; founder photos square, at least 400 px, face centred. The build trims uniform borders and fits logos inside 480×240, and crops photos to 160×160 squares.

To load files into Airtable without dragging them in by hand (for example a batch processed with the circle-crop tooling), Airtable's attachment API needs a URL it can fetch. **Do not commit the files to this repo for that purpose**: the repo is public and anything committed stays in its history for good, which would permanently associate an undercover charity or founder with AIM. Use a transient GitHub release asset instead, which lives outside git history and can be deleted:

```
gh release create img-staging --target main --prerelease --title "Image staging" --notes "Transient; assets deleted after import."
cp photo.webp $(openssl rand -hex 8).webp          # opaque name: the URL is public while it exists
gh release upload img-staging <hex>.webp
# import into Airtable by https://github.com/<owner>/<repo>/releases/download/img-staging/<hex>.webp,
# passing the real name in the attachment's "filename" so Airtable stores it sensibly
# wait until the attachment's url is on airtableusercontent.com (Airtable copies asynchronously), then:
gh release delete img-staging --cleanup-tag --yes
```

Airtable skips a URL it has imported before, so never reuse a staging filename; a fresh random name each time also avoids the five-minute raw-content cache. `uploads/` is gitignored and must stay that way.

If a row has no attachment, the build falls back to a local, untracked `assets/logos/<charity id>.webp` or `assets/founders/<charity id>/<founder slug>.webp`; this exists only for one-off bulk loads and is not part of the normal workflow. The build lists every published charity without a logo and every founder without a photo.

## Publishing rules

A charity is published only when **Website ready?** is ticked, **Undercover?** and **Exclude from website** are unticked, and **Status** is Active, Shutdown or Merged. The build applies these in the Airtable filter formula *and* re-checks them in code. Only the fields listed in `config/publish.json → allowlist` are ever read from the API or written to the output. Cause tag names must match in three places: the Airtable multi-select option, `config/publish.json → causeTags`, and the colour map at the top of `public/widget.js` (a rename there means re-pasting the snippet). A blurb may contain links written as `[text](https://example.org)`; the widget renders them as links and shows everything else as plain text. Cards are ordered by **Sort order** (lower first, blanks alphabetically after), and Shutdown/Merged charities always come after active ones regardless of Sort order. Founders are published only for published charities, and a founder row with its own **Undercover?** ticked is dropped entirely, so an individual can be held back even when their charity is public: no name, role, photo or LinkedIn is published and the card shows only the other founders (the build logs how many were held back). Their **LinkedIn** field (a URL on Website Founders) turns the founder's name into a link, and anything that isn't a linkedin.com URL is dropped with a warning.

### Stealth-mode counts

Charities that are Active with **Undercover?** ticked (and **Exclude from website** unticked) are never published, but they are *counted*: the build fetches only their cause tags and control fields, and writes an aggregate `stealth: { total, byCause }` to `charities.json` (rules in `config/publish.json → stealthConditions`; per-cause counts are published only for the causes in `publishCauses`, currently Animal welfare, so small counts for other causes never appear; the verify step allows whole numbers there and nothing else). The widget adds these counts to the cause chips and the headline total whenever no region filter is active, and appends a dashed "N charities in stealth mode" card at the end of a plain cause view. The card never appears together with a cohort, region or search, so nobody can narrow a stealth count down to a cohort or country. Untagged undercover charities count towards the total but not towards any cause.

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
