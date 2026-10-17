# AIM charity directory

Embeddable "our charities" directory for the Ambitious Impact (AIM) Squarespace site, fed from the **AIM Website Content** Airtable base.

```
MEL base (Charities → Places of operation)        read-only, always
   │  scripts/sync-from-mel.mjs  — nightly, before the build; writes the website base's Countries only
   ▼
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
| `config/sync.json` | MEL → website sync: both bases' table and field ids, which fields are synced, UN → short country names |
| `data/continents.json` | Country → continent lookup (owned here, not in Airtable) |
| `scripts/build.mjs` | Pull Airtable → transform → rehost images → `public/charities.json` |
| `scripts/lib/` | `airtable.mjs` (REST client, read), `airtable-write.mjs` (schema + writes, website base only), `transform.mjs` (pure transform), `images.mjs` (rehosting), `mel-sync.mjs` (pure sync logic) |
| `scripts/sync-from-mel.mjs` | Nightly MEL → website sync: Countries follow MEL's Places of operation; new MEL charities get a website row (see [Syncing Countries from MEL](#syncing-countries-from-mel)) |
| `scripts/sync-from-mel.test.mjs` | Unit tests for the sync logic (`npm test`) |
| `scripts/verify-allowlist.mjs` | Fails if the published JSON contains anything outside the allowlist |
| `scripts/make-snippet.mjs` | Builds `public/snippet.html` (the Squarespace code block: widget + inline data snapshot + live URL) and `public/demo.html` (self-contained preview) |
| `public/widget.css`, `public/widget.js` | The widget itself: dependency-free, every style scoped under `.aim-dir` |
| `public/index.html` | Preview page that fetches `charities.json` (add `?bleed=1` for the theme-bleed stress test) |
| `public/` | Everything that gets deployed to GitHub Pages (`charities.json` tracked; images, snippet and demo are build outputs) |
| `.github/workflows/build.yml` | Nightly MEL sync, then build and Pages deployment (manual runs too; a push only rebuilds) |
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

Charities that are Active with **Undercover?** ticked (and **Exclude from website** unticked) are never published, but they are *counted*: the build fetches only their cause tags and control fields, and writes an aggregate `stealth: { total, byCause }` to `charities.json` (rules in `config/publish.json → stealthConditions`; per-cause counts are published only for the causes in `publishCauses`, currently Animal welfare, so small counts for other causes never appear; the verify step allows whole numbers there and nothing else). The widget adds these counts to the cause chips and the headline total whenever no region filter is active, and appends a dashed "N more charities" card at the end of a plain cause view (the card names no cause and carries no cause chip, since it only appears while that cause is the active filter). The card never appears together with a cohort, region or search, so nobody can narrow a stealth count down to a cohort or country. Untagged undercover charities count towards the total but not towards any cause.

## Deep links

`/our-charities?q=healthier+hens` opens the page with "healthier hens" already in the search box, the results filtered to it, and the page scrolled to the directory (the page's `#directory` section when the widget sits inside one, else the widget itself). The term is matched exactly like a typed search, so every word must appear somewhere in the charity's name, founders, blurb, cohort, causes or countries: use the charity's name, and prefer one that matches a single card. `#q=healthier+hens` and `#directory?q=healthier+hens` do the same for hosts whose redirects strip query strings. The old per-charity pages on charityentrepreneurship.com are pointed at these links from Squarespace's URL mappings. `{ urlQuery: false }` on `mount()` switches the behaviour off.

## Syncing Countries from MEL

MEL (the research team's base, *Research Team - CEIP Database*) is the one place where a charity's places of operation are maintained. Every night, before the build, `scripts/sync-from-mel.mjs` copies them into the website base's **Countries** field, and the build then publishes the website base as before. MEL is only ever read: the script registers the MEL base as read-only in code before it does anything else, and every write function refuses a request aimed at it, whatever token the process was given.

**Token.** The sync has its own personal access token, read from the environment variable `MEL_SYNC_TOKEN` (repository secret of the same name) and nowhere else. Scopes: `data.records:read` on the MEL base; `data.records:read`, `data.records:write` and `schema.bases:read` on the website base (the schema scope is what lets it find the override checkbox by name). Never reuse `AIRTABLE_TOKEN2`, which stays read-only on the website base alone. Same handling rules as the build token: never commit it, never paste it into chat, never echo it; locally it lives in `~/.zprofile`.

**What a charity's Countries become.** Each link in MEL's *Places of operation* is turned into a website option: a place of type *Country or area* is itself; a *Subnational entity* contributes its parent country (its *Is part of* link of country type); "Global" and "Europe" are kept as the website options of the same name; every other region and income group is dropped. UN names become the short names the website uses (`config/sync.json → countryNameMap`: "Viet Nam" → "Vietnam", "United Kingdom of Great Britain and Northern Ireland" → "United Kingdom", ...). Writes use typecast, so a country that is not yet a Countries option is added automatically; the dry run lists those, and the ones missing from `data/continents.json` (add them there, or they only show under "All" on the site).

**When a row is left alone.**

- MEL's Places of operation is blank, or lists only regions and income groups: **blank never clears the website**.
- The row's **Countries: manual** checkbox is ticked: the row is curated by hand (Animal Policy International keeps "Europe" while MEL lists Belgium). The script finds the checkbox by name in the base schema at run time, falls back to the id recorded in `config/sync.json` if it has been renamed, and refuses to apply if neither resolves.
- The computed list already equals the current one (order does not matter).
- The row has no MEL Charity ID, or shares one with another row (reported with suggested matches, never written).

**Hand-curated rows are still watched.** The sync computes MEL's list for every linked row on every run and remembers it in the row's **Countries (from MEL)** field, a long-text field the sync owns (comma-separated, sorted, `(none)` when MEL has nothing; never edit it). When the remembered list changes for a row with **Countries: manual** ticked, i.e. MEL gained or lost a country for a charity whose website list is curated, the run flags it in the job log, the step summary and the Slack digest under "Hand-curated rows where MEL changed", additions first, together with MEL's full list, the website's current list and the instruction to untick the checkbox if MEL should win. A flag is raised once, when MEL changes, never for a standing difference, and it counts as a change, so the digest posts even on a night with no Countries writes. Like the checkbox, the field is found by name at run time (id fallback in `config/sync.json`) and the script refuses to apply without it. The remembered value is written last, after the digest, so a failed post flags the same change again the next night.

Only **Countries** is written to existing rows. Status, Cohort label and Undercover? are computed from MEL too and any difference is reported as "not synced"; to start writing one, add its key to `config/sync.json → sync.fields` and an override checkbox under `overrideFieldsByName`. Nothing else in a row (Blurb, Logo, Website ready?, Sort order, ...) is ever touched: updates are PATCH requests carrying the synced field alone.

**New rows.** A MEL charity with no website row gets one: Display name (the MEL name, edit freely afterwards), MEL Charity ID, Cohort label, Status, Countries, Countries (from MEL), and Undercover? ticked when MEL's Undercover? is non-blank. Website ready? is left unticked, so nothing is published until someone completes the row.

**Running it locally.**

```bash
export MEL_SYNC_TOKEN=...                                          # in your own shell only
npm run sync:dry-run                                               # full planned diff; nothing written
node scripts/sync-from-mel.mjs --dry-run --dump-raw raw/mel-sync   # also keep the fetched records (gitignored raw/)
node scripts/sync-from-mel.mjs --dry-run --from-raw raw/mel-sync   # offline re-run from that dump (no token; --apply refused)
npm run sync:apply                                                 # write the planned changes to the website base
npm test                                                           # unit tests of the diff logic
```

Flags: `--digest` posts a short summary to the Slack incoming webhook in `SLACK_WEBHOOK_URL`, only when something changed: a Countries write, a new row or a manual-row flag (or, in a dry run, would change); `--redact` names only rows that are already public on the website, everything else appears as `[hidden] rec...` (the Action always passes it: on a public repository the job logs and step summaries are public, and the sync sees undercover and unannounced charities; the Slack digest keeps full names); `--summary FILE` writes a markdown table (defaults to the Actions step summary).

**In the Action.** The `sync` job runs before `build` on the nightly schedule and on manual runs, not on pushes. Its mode is the *sync_mode* input of a manual run, else the repository variable **`MEL_SYNC_MODE`**, else `apply`:

| `MEL_SYNC_MODE` | What happens every night |
| --- | --- |
| `apply` (default) | Auto-apply: Countries are written, every change is in the job log, and the Slack digest (secret `MEL_SYNC_SLACK_WEBHOOK`, an incoming webhook for the agreed channel) lists what changed. Nothing is posted on a night with no changes |
| `dry-run` | Stage for approval: nothing is written; the planned diff is in the job log and step summary and the digest says what is pending. To apply, run the workflow by hand with *sync_mode* = apply |
| `off` | The job is skipped |

So the first nightly run after this lands will write, provided the secret, the **Countries: manual** checkbox and the **Countries (from MEL)** field exist (without them the job fails and writes nothing). To look before it does, run the workflow by hand with *sync_mode* = dry-run, or `npm run sync:dry-run` locally. The build runs even when the sync fails, so the site never goes stale because of it, but the failed job still turns the run red.

## Deployment

`.github/workflows/build.yml` runs every night at 03:17 UTC, on every push to `main`, and on demand (Actions tab → *Build and deploy directory* → *Run workflow*). Nightly and manual runs start with the MEL sync job described above; then the build pulls Airtable with the repository secret **`AIRTABLE_TOKEN2`**, builds `public/`, runs the allowlist check, generates the snippet, commits a changed `public/charities.json` back to `main`, and deploys `public/` to GitHub Pages:

| URL | What |
| --- | --- |
| https://aidan-alexander.github.io/aim-charity-directory/ | Preview page with the live data |
| https://aidan-alexander.github.io/aim-charity-directory/charities.json | The JSON the widget refreshes from |
| https://aidan-alexander.github.io/aim-charity-directory/snippet.txt | The Squarespace code-block content as plain text, regenerated every build: open, select all, copy, paste into the code block |
| https://aidan-alexander.github.io/aim-charity-directory/demo.html | Self-contained demo of exactly what the code block renders |

`public/img/`, `public/snippet.html` and `public/demo.html` are build outputs and are not tracked in git; `public/charities.json` is tracked so the widget can be developed locally without an Airtable token. The Pages base URL lives in `config/publish.json → pagesBaseUrl`; if the repo is ever transferred or renamed, change it there and re-paste the snippet.

Images are re-encoded at build time (`config/publish.json → images`): logos have uniform borders trimmed and are fitted inside 480×240, founder photos become 160×160 squares, everything except SVG becomes WebP.

_Token rotation and repo transfer notes are completed in the wrap-up phase._
