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
| `public/` | Everything that gets deployed to GitHub Pages |
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

## Publishing rules

A charity is published only when **Website ready?** is ticked, **Undercover?** and **Exclude from website** are unticked, and **Status** is Active, Shutdown or Merged. The build applies these in the Airtable filter formula *and* re-checks them in code. Only the fields listed in `config/publish.json → allowlist` are ever read from the API or written to the output. Founders are published only for published charities.

_Full update workflow, snippet re-paste, token rotation and repo transfer notes are added in the wrap-up phase._
