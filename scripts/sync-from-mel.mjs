#!/usr/bin/env node
// MEL -> website sync. Keeps the website base's Countries in step with MEL's "Places of operation", creates a
// website row for any MEL charity that has none, and flags hand-curated rows whose MEL list has changed.
// MEL is only ever read.
//
//   node scripts/sync-from-mel.mjs --dry-run             print the full planned diff and flags; write nothing
//   node scripts/sync-from-mel.mjs --apply               write the planned changes to the website base
//
//   --digest           post a short Slack summary to SLACK_WEBHOOK_URL, only when something changed (a Countries
//                      write, a new row or a drift flag; in a dry run: would change); skipped when the variable is unset
//   --redact           name only rows that are already public on the website; everything else is "[hidden] rec..."
//                      (the Action passes this: logs and step summaries of a public repository are public)
//   --dump-raw DIR     also save the fetched records to DIR (gitignored raw/) for debugging or an offline run
//   --from-raw DIR     offline: plan from a previous dump instead of calling Airtable (no token needed; --apply refused)
//   --summary FILE     write a markdown summary to FILE (defaults to $GITHUB_STEP_SUMMARY when that is set)
//
// Environment:
//   MEL_SYNC_TOKEN     Airtable personal access token: data.records:read on the MEL base; data.records:read,
//                      data.records:write and schema.bases:read on the website base. Never AIRTABLE_TOKEN2.
//   SLACK_WEBHOOK_URL  incoming-webhook URL for --digest (optional)
//
// Exit codes: 0 done (warnings are not failures), 1 error, 2 refused (--apply offline, or without the override
// checkbox / state field the website table needs).

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTokenFromEnv, listAllRecords } from './lib/airtable.mjs';
import { createRecords, findFieldById, forbidWrites, getBaseSchema, patchRecords } from './lib/airtable-write.mjs';
import {
  formatDigest,
  formatPlan,
  formatStepSummary,
  hasChanges,
  indexCohorts,
  indexPlaces,
  label,
  planSync,
  resolveOverrideFields,
  resolveStateFields,
} from './lib/mel-sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_FILES = {
  melCharities: 'mel-charities.json',
  melPlaces: 'mel-places.json',
  melCohorts: 'mel-cohorts.json',
  websiteRows: 'website.json',
  websiteSchema: 'website-schema.json',
};

function usage() {
  return 'Usage: node scripts/sync-from-mel.mjs (--dry-run | --apply) [--digest] [--redact] [--dump-raw DIR] [--from-raw DIR] [--summary FILE]';
}

function parseArgs(argv) {
  const args = { mode: null, digest: false, redact: false, dumpRaw: null, fromRaw: null, summary: process.env.GITHUB_STEP_SUMMARY || null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--apply') {
      if (args.mode && args.mode !== a.slice(2)) throw new Error('Pass either --dry-run or --apply, not both');
      args.mode = a.slice(2);
    } else if (a === '--digest') args.digest = true;
    else if (a === '--redact') args.redact = true;
    else if (a === '--dump-raw') args.dumpRaw = argv[++i];
    else if (a === '--from-raw') args.fromRaw = argv[++i];
    else if (a === '--summary') args.summary = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}\n${usage()}`);
  }
  if (!args.mode) throw new Error(`Say what you want: --dry-run (report only) or --apply (write).\n${usage()}`);
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fetchAll({ token, cfg, log }) {
  const { mel, website } = cfg;
  const C = mel.tables.charities;
  const P = mel.tables.places;
  const K = mel.tables.cohorts;
  log(`Reading MEL base ${mel.baseId} (read-only)`);
  const melCharities = await listAllRecords({ token, baseId: mel.baseId, tableId: C.id, fields: Object.values(C.fields), returnFieldsByFieldId: true, log });
  const melPlaces = await listAllRecords({ token, baseId: mel.baseId, tableId: P.id, fields: Object.values(P.fields), returnFieldsByFieldId: true, log });
  const melCohorts = await listAllRecords({ token, baseId: mel.baseId, tableId: K.id, fields: Object.values(K.fields), returnFieldsByFieldId: true, log });
  log(`Reading website base ${website.baseId}`);
  const websiteSchema = await getBaseSchema({ token, baseId: website.baseId });
  const overrides = resolveOverrideFields(websiteSchema, cfg);
  const states = resolveStateFields(websiteSchema, cfg);
  const websiteRows = await listAllRecords({
    token,
    baseId: website.baseId,
    tableId: website.table.id,
    fields: [...Object.values(website.fields), ...Object.values(overrides.ids), ...Object.values(states.ids)],
    returnFieldsByFieldId: true,
    log,
  });
  return { melCharities, melPlaces, melCohorts, websiteSchema, websiteRows };
}

async function loadRaw(dir) {
  const out = {};
  for (const [key, file] of Object.entries(RAW_FILES)) out[key] = await readJson(path.join(dir, file));
  return out;
}

async function saveRaw(dir, data) {
  await mkdir(dir, { recursive: true });
  for (const [key, file] of Object.entries(RAW_FILES)) await writeFile(path.join(dir, file), `${JSON.stringify(data[key], null, 2)}\n`);
}

async function postSlack(webhook, text) {
  const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`Slack webhook responded ${res.status} ${res.statusText}`);
}

/** Content writes: Countries (and any other synced field) on existing rows, then new rows. */
async function applyContent(plan, { token, cfg, redact, log }) {
  const { baseId, table } = cfg.website;
  const results = { updated: 0, created: 0 };
  if (plan.updates.length) {
    const records = plan.updates.map((u) => ({ id: u.websiteId, fields: Object.fromEntries(u.fields.map((f) => [f.fieldId, f.after])) }));
    const updated = await patchRecords({ token, baseId, tableId: table.id, records, typecast: true, log });
    const returned = new Set(updated.map((r) => r.id));
    for (const u of plan.updates) {
      const ok = returned.has(u.websiteId);
      results.updated += ok ? 1 : 0;
      for (const f of u.fields) log(`  ${ok ? 'updated' : 'NOT CONFIRMED'} ${label(u, redact)}: ${f.label}: ${redact && u.hidden ? '(values hidden)' : `${f.beforeText} -> ${f.afterText}`}`);
    }
  }
  if (plan.creates.length) {
    const created = await createRecords({ token, baseId, tableId: table.id, records: plan.creates.map((c) => ({ fields: c.fields })), typecast: true, log });
    results.created = created.length;
    for (const c of plan.creates) log(`  created row for ${label(c, redact)}`);
  }
  return results;
}

/**
 * Bookkeeping writes: the "(from MEL)" state fields. Written LAST, after the digest has gone out, so that a failed
 * post leaves the remembered value unchanged and the same drift is flagged again on the next run.
 */
async function applyState(plan, { token, cfg, log }) {
  if (!plan.stateUpdates.length) return 0;
  const byRecord = new Map();
  for (const s of plan.stateUpdates) {
    if (!byRecord.has(s.websiteId)) byRecord.set(s.websiteId, { id: s.websiteId, fields: {} });
    byRecord.get(s.websiteId).fields[s.fieldId] = s.after;
  }
  const updated = await patchRecords({ token, baseId: cfg.website.baseId, tableId: cfg.website.table.id, records: [...byRecord.values()], typecast: false, log });
  return updated.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(m);
  const cfg = await readJson(path.join(ROOT, 'config', 'sync.json'));
  const publish = await readJson(path.join(ROOT, 'config', 'publish.json'));
  const continents = await readJson(path.join(ROOT, 'data', 'continents.json'));
  forbidWrites(cfg.mel.baseId); // belt and braces: no write can ever be aimed at MEL from this process

  const apply = args.mode === 'apply';
  log(apply ? 'MEL -> website sync: APPLY (the website base will be written)' : 'MEL -> website sync: DRY RUN (nothing will be written)');
  log(`  synced fields: ${cfg.sync.fields.join(', ')}; create missing rows: ${cfg.sync.createMissingRows ? 'yes' : 'no'}; output ${args.redact ? 'redacted (public log)' : 'unredacted'}`);

  let data;
  let token = null;
  if (args.fromRaw) {
    if (apply) {
      console.error('Refusing --apply with --from-raw: an offline dump may be stale. Run --apply against the live bases.');
      process.exit(2);
    }
    const dir = path.resolve(ROOT, args.fromRaw);
    log(`  offline: reading records from ${dir}`);
    data = await loadRaw(dir);
  } else {
    token = getTokenFromEnv('MEL_SYNC_TOKEN', '  export MEL_SYNC_TOKEN=...\n  node scripts/sync-from-mel.mjs --dry-run');
    data = await fetchAll({ token, cfg, log });
    if (args.dumpRaw) {
      const dir = path.resolve(ROOT, args.dumpRaw);
      await saveRaw(dir, data);
      log(`  raw records written to ${dir} (gitignored; MEL data, keep it local)`);
    }
  }
  log(`  MEL: ${data.melCharities.length} charities, ${data.melPlaces.length} places, ${data.melCohorts.length} cohorts; website: ${data.websiteRows.length} rows`);

  // The two kinds of helper field the Website table must have: override checkboxes and "(from MEL)" state fields.
  const overrides = resolveOverrideFields(data.websiteSchema, cfg);
  const states = resolveStateFields(data.websiteSchema, cfg);
  for (const [key, id] of Object.entries(overrides.ids)) log(`  override checkbox for ${key}: "${cfg.website.overrideFieldsByName[key]}" = ${id}`);
  for (const [key, id] of Object.entries(states.ids)) log(`  state field for ${key}: "${cfg.website.stateFieldsByName[key]}" = ${id}`);
  for (const w of [...overrides.warnings, ...states.warnings]) log(`  WARNING: ${w}`);
  let refuse = false;
  if (overrides.missing.length) {
    log(`  WARNING: override checkbox missing from the website table: ${overrides.missing.join(', ')}. Add it (checkbox) before any --apply.`);
    refuse = true;
  }
  if (states.missing.length) {
    log(`  WARNING: state field missing from the website table: ${states.missing.join(', ')}. Add it (long text) before any --apply; without it, hand-curated rows cannot be flagged when MEL changes.`);
    refuse = true;
  }
  if (refuse && apply) {
    console.error('Refusing --apply: the Website table lacks a helper field the sync relies on (see the warnings above).');
    process.exit(2);
  }

  const places = indexPlaces(data.melPlaces, cfg.mel.tables.places.fields);
  const cohorts = indexCohorts(data.melCohorts, cfg.mel.tables.cohorts.fields);
  const placeNames = new Set([...places.values()].map((p) => p.name));
  for (const region of cfg.mel.regionsKeptAsOptions || []) {
    if (!placeNames.has(region)) log(`  note: MEL Places has no row named "${region}" yet, so MEL cannot express it until one is added`);
  }
  const countriesField = findFieldById(data.websiteSchema, cfg.website.table.id, cfg.website.fields.countries);
  const countryOptions = countriesField?.options?.choices ? countriesField.options.choices.map((c) => c.name) : null;

  const plan = planSync(
    { mel: data.melCharities, website: data.websiteRows, places, cohorts, countryOptions },
    { config: cfg, overrideFieldIds: overrides.ids, stateFieldIds: states.ids, statusIn: publish.publishConditions.statusIn, continents }
  );

  log('');
  for (const line of formatPlan(plan, { mode: args.mode, redact: args.redact })) log(line);
  log('');

  let outcome = hasChanges(plan) ? (apply ? 'changes applied' : 'changes pending') : 'nothing to do';
  if (apply) {
    if (plan.updates.length || plan.creates.length) {
      log('Writing to the website base...');
      const results = await applyContent(plan, { token, cfg, redact: args.redact, log });
      log(`Done: ${results.updated} row(s) updated, ${results.created} row(s) created.`);
      if (results.updated !== plan.updates.length) {
        outcome = 'partial';
        console.error(`Airtable confirmed ${results.updated} of ${plan.updates.length} updates.`);
      }
    } else {
      log('No content to write.');
    }
  }

  if (args.summary) {
    await appendFile(args.summary, formatStepSummary(plan, { mode: args.mode, redact: args.redact }));
    log(`Summary written to ${args.summary}`);
  }

  if (args.digest) {
    const webhook = (process.env.SLACK_WEBHOOK_URL || '').trim();
    if (!webhook) log('Digest: SLACK_WEBHOOK_URL is not set; skipping.');
    else if (!hasChanges(plan)) log('Digest: nothing changed; not posting.');
    else {
      await postSlack(webhook, formatDigest(plan, { mode: args.mode }));
      log('Digest posted to Slack.');
    }
  }

  if (apply && plan.stateUpdates.length) {
    const n = await applyState(plan, { token, cfg, log });
    log(`State: remembered MEL values refreshed on ${n} row(s).`);
  }

  log(`Result: ${outcome}.`);
  if (outcome === 'partial') process.exit(1);
}

main().catch(async (err) => {
  console.error(`\nSync failed: ${err.message}`);
  const webhook = (process.env.SLACK_WEBHOOK_URL || '').trim();
  if (process.argv.includes('--digest') && webhook) {
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `MEL -> website sync FAILED: ${err.message.split('\n')[0]}` }) }).catch(() => {});
  }
  process.exit(1);
});
