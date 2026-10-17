// Unit tests for the MEL -> website sync logic (no network). Run with `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cohortLabelFrom,
  countriesFromPlaces,
  describeChange,
  formatDigest,
  formatPlan,
  formatStepSummary,
  hasChanges,
  humanList,
  indexCohorts,
  indexPlaces,
  label,
  normaliseCountries,
  planSync,
  resolveOverrideFields,
  resolveStateFields,
  sameCountries,
} from './lib/mel-sync.mjs';
import { forbidWrites, patchRecords } from './lib/airtable-write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'config', 'sync.json'), 'utf8'));
const F = config.website.fields;
const M = config.mel.tables.charities.fields;
const P = config.mel.tables.places.fields;
const K = config.mel.tables.cohorts.fields;
const OVERRIDE = 'fldOVERRIDE0000001';

// A tiny MEL Places table: two countries with UN names, a state linked to itself + its country, two regions, one income group.
const placeRecords = [
  { id: 'recIndia', fields: { [P.name]: 'India', [P.type]: 'Country or area', [P.partOf]: ['recIndia', 'recSouthAsia', 'recLMI'] } },
  { id: 'recUK', fields: { [P.name]: 'United Kingdom of Great Britain and Northern Ireland', [P.type]: 'Country or area', [P.partOf]: ['recUK', 'recEurope'] } },
  { id: 'recVN', fields: { [P.name]: 'Viet Nam', [P.type]: 'Country or area', [P.partOf]: ['recVN'] } },
  { id: 'recBihar', fields: { [P.name]: 'Bihar', [P.type]: 'Subnational entity', [P.partOf]: ['recBihar', 'recIndia'] } },
  { id: 'recOrphan', fields: { [P.name]: 'Orphan State', [P.type]: 'Subnational entity', [P.partOf]: ['recOrphan'] } },
  { id: 'recEurope', fields: { [P.name]: 'Europe', [P.type]: 'UN Geoscheme continental region', [P.partOf]: [] } },
  { id: 'recSouthAsia', fields: { [P.name]: 'Southern Asia', [P.type]: 'UN Geoscheme subregion', [P.partOf]: [] } },
  { id: 'recLMI', fields: { [P.name]: 'Lower middle income', [P.type]: 'World Bank income classification', [P.partOf]: [] } },
  { id: 'recGlobal', fields: { [P.name]: 'Global' } }, // MEL's real Global row has no Type: kept by name alone
];
const places = indexPlaces(placeRecords, P);
const cohorts = indexCohorts(
  [
    { id: 'recC2025H1', fields: { [K.name]: '2025 H1 ' } },
    { id: 'recCEGI', fields: { [K.name]: '2024 EGI' } },
  ],
  K
);
const placeRules = { placeTypes: config.mel.placeTypes, regionsKept: config.mel.regionsKeptAsOptions, nameMap: config.countryNameMap };

const melRecord = (id, name, placeIds, extra = {}) => ({
  id,
  fields: { [M.name]: name, [M.places]: placeIds, [M.status]: 'Active', [M.cohort]: ['recC2025H1'], ...extra },
});
const websiteRow = (id, name, melId, countries, extra = {}) => ({
  id,
  fields: { [F.displayName]: name, [F.melCharityId]: melId, [F.countries]: countries, [F.status]: 'Active', [F.cohortLabel]: '2025 H1', [F.websiteReady]: true, ...extra },
});
const plan = (mel, website, opts = {}) => planSync({ mel, website, places, cohorts, countryOptions: opts.countryOptions ?? null }, { config, overrideFieldIds: { countries: OVERRIDE }, ...opts });

test('countries: countries map to short names, states to their country, kept regions stay, the rest is dropped', () => {
  const r = countriesFromPlaces(['recUK', 'recBihar', 'recVN', 'recEurope', 'recSouthAsia', 'recLMI', 'recGlobal', 'recNope'], places, placeRules);
  assert.deepEqual(r.countries, ['Global', 'Europe', 'India', 'United Kingdom', 'Vietnam']);
  assert.deepEqual(r.dropped, ['Southern Asia', 'Lower middle income']);
  assert.deepEqual(r.unknown, ['recNope']);
});

test('countries: "Global" is kept by name even though its MEL row has no Type', () => {
  const r = countriesFromPlaces(['recGlobal'], places, placeRules);
  assert.deepEqual(r.countries, ['Global']);
  assert.deepEqual(r.dropped, []);
});

test('override checkbox: found by name; by known id with a warning when renamed; missing or wrong type otherwise', () => {
  const schema = (fields) => ({ tables: [{ id: config.website.table.id, name: 'Website', fields }] });
  const byName = resolveOverrideFields(schema([{ id: 'fldXQcC73J3XDKZXT', name: 'Countries: manual', type: 'checkbox' }]), config);
  assert.deepEqual(byName, { ids: { countries: 'fldXQcC73J3XDKZXT' }, missing: [], warnings: [] });
  const renamed = resolveOverrideFields(schema([{ id: 'fldXQcC73J3XDKZXT', name: 'Countries: hand-curated', type: 'checkbox' }]), config);
  assert.deepEqual(renamed.ids, { countries: 'fldXQcC73J3XDKZXT' });
  assert.match(renamed.warnings[0], /no field named "Countries: manual"/);
  const other = resolveOverrideFields(schema([{ id: 'fldOTHER0000000001', name: 'Countries: manual', type: 'checkbox' }]), config);
  assert.deepEqual(other.ids, { countries: 'fldOTHER0000000001' });
  assert.match(other.warnings[0], /config\/sync.json/);
  const wrongType = resolveOverrideFields(schema([{ id: 'fldXQcC73J3XDKZXT', name: 'Countries: manual', type: 'singleLineText' }]), config);
  assert.deepEqual(wrongType.ids, {});
  assert.match(wrongType.missing[0], /not a checkbox/);
  const absent = resolveOverrideFields(schema([]), config);
  assert.deepEqual(absent, { ids: {}, missing: ['Countries: manual'], warnings: [] });
});

test('countries: a state without a parent country is ignored with a note', () => {
  const r = countriesFromPlaces(['recOrphan'], places, placeRules);
  assert.deepEqual(r.countries, []);
  assert.match(r.notes[0], /Orphan State/);
});

test('countries: comparison ignores order and duplicates; normalisation puts kept regions first', () => {
  assert.ok(sameCountries(['India', 'Kenya'], ['Kenya', 'India', 'India']));
  assert.ok(!sameCountries(['India'], ['India', 'Kenya']));
  assert.deepEqual(normaliseCountries(['Kenya', 'Europe', 'India', 'Global'], ['Global', 'Europe']), ['Global', 'Europe', 'India', 'Kenya']);
});

test('cohort label: trimmed and EGI spelled out', () => {
  assert.equal(cohortLabelFrom(['recC2025H1'], cohorts, config.cohortLabel).value, '2025 H1');
  assert.equal(cohortLabelFrom(['recCEGI'], cohorts, config.cohortLabel).value, '2024 Effective Giving');
  assert.equal(cohortLabelFrom([], cohorts, config.cohortLabel).value, '');
});

test('plan: a row whose Countries already match MEL is left alone', () => {
  const p = plan([melRecord('recM1', 'Ansh', ['recIndia', 'recBihar'])], [websiteRow('recW1', 'Ansh', 'recM1', ['India'])]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.stats.unchanged, 1);
});

test('plan: a differing row gets exactly one update, on the Countries field id only', () => {
  const p = plan([melRecord('recM1', 'Scale Welfare', ['recVN', 'recIndia'])], [websiteRow('recW1', 'Scale Welfare', 'recM1', ['Vietnam'])]);
  assert.equal(p.updates.length, 1);
  assert.equal(p.updates[0].fields.length, 1);
  assert.equal(p.updates[0].fields[0].fieldId, F.countries);
  assert.deepEqual(p.updates[0].fields[0].after, ['India', 'Vietnam']);
  assert.deepEqual(p.updates[0].fields[0].before, ['Vietnam']);
});

test('plan: blank MEL never clears the website', () => {
  const p = plan([melRecord('recM1', 'Suvita', [])], [websiteRow('recW1', 'Suvita', 'recM1', ['India'])]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.skipped.length, 1);
  assert.match(p.skipped[0].reason, /blank/);
});

test('plan: MEL holding only regions/income groups is treated like blank', () => {
  const p = plan([melRecord('recM1', 'X', ['recSouthAsia', 'recLMI'])], [websiteRow('recW1', 'X', 'recM1', ['India'])]);
  assert.equal(p.updates.length, 0);
  assert.match(p.skipped[0].reason, /only regions/);
});

test('plan: the manual override checkbox blocks the write', () => {
  const p = plan([melRecord('recM1', 'Animal Policy International', ['recUK'])], [websiteRow('recW1', 'Animal Policy International', 'recM1', ['Europe', 'United Kingdom'], { [OVERRIDE]: true })]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.skipped.length, 1);
  assert.match(p.skipped[0].reason, /Countries: manual/);
});

test('plan: without an override field id the row is written (the CLI refuses --apply in that case)', () => {
  const p = planSync({ mel: [melRecord('recM1', 'A', ['recUK'])], website: [websiteRow('recW1', 'A', 'recM1', ['Europe'], { [OVERRIDE]: true })], places, cohorts }, { config, overrideFieldIds: {} });
  assert.equal(p.updates.length, 1);
});

test('plan: a MEL charity with no website row is created with the agreed fields and Website ready? unticked', () => {
  const p = plan([melRecord('recM9', 'New Charity', ['recBihar'], { [M.undercover]: 'Yes', [M.cohort]: ['recCEGI'] })], []);
  assert.equal(p.creates.length, 1);
  const c = p.creates[0];
  assert.equal(c.fields[F.displayName], 'New Charity');
  assert.equal(c.fields[F.melCharityId], 'recM9');
  assert.equal(c.fields[F.cohortLabel], '2024 Effective Giving');
  assert.equal(c.fields[F.status], 'Active');
  assert.deepEqual(c.fields[F.countries], ['India']);
  assert.equal(c.fields[F.undercover], true);
  assert.ok(!(F.websiteReady in c.fields));
  assert.ok(!(F.excludeFromWebsite in c.fields));
  assert.ok(c.hidden);
});

test('plan: a MEL charity that is not undercover is created without the Undercover? key and without blank Countries', () => {
  const p = plan([melRecord('recM9', 'Plain', [])], []);
  const c = p.creates[0];
  assert.ok(!(F.undercover in c.fields));
  assert.ok(!(F.countries in c.fields));
});

test('plan: createMissingRows=false creates nothing', () => {
  const cfg = { ...config, sync: { ...config.sync, createMissingRows: false } };
  const p = planSync({ mel: [melRecord('recM9', 'New', ['recIndia'])], website: [], places, cohorts }, { config: cfg, overrideFieldIds: {} });
  assert.equal(p.creates.length, 0);
});

test('plan: duplicated MEL Charity IDs are warned about and never written', () => {
  const p = plan([melRecord('recM1', 'A', ['recUK'])], [websiteRow('recW1', 'A', 'recM1', []), websiteRow('recW2', 'A copy', 'recM1', [])]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.creates.length, 0);
  assert.equal(p.warnings.filter((w) => w.code === 'duplicate-key').length, 1);
});

test('plan: a website key that points at no MEL record is warned about', () => {
  const p = plan([], [websiteRow('recW1', 'Ghost', 'recGone', ['India'])]);
  assert.equal(p.warnings.filter((w) => w.code === 'stale-key').length, 1);
});

test('plan: unlinked website rows are reported with MEL name suggestions, never written', () => {
  const p = plan([melRecord('recM1', 'Lafiya Nigeria', ['recIndia'], { [M.previousNames]: 'Lafiya, Old Name' })], [websiteRow('recW1', 'Lafiya', '', ['Nigeria'])]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.unlinked.length, 1);
  assert.deepEqual(p.unlinked[0].suggestions, [{ melId: 'recM1', melName: 'Lafiya Nigeria' }]);
});

test('plan: fields outside sync.fields are reported as not synced, not written', () => {
  const p = plan([melRecord('recM1', 'Canopie', ['recIndia'], { [M.status]: 'For-Profit pivot' })], [websiteRow('recW1', 'Canopie', 'recM1', ['India'])]);
  assert.equal(p.updates.length, 0);
  const diff = p.notSynced.find((d) => d.key === 'status');
  assert.ok(diff);
  assert.equal(diff.before, 'Active');
  assert.equal(diff.after, 'For-Profit pivot');
});

test('plan: enabling status in sync.fields turns the same difference into an update', () => {
  const cfg = { ...config, sync: { ...config.sync, fields: ['countries', 'status'] } };
  const p = planSync({ mel: [melRecord('recM1', 'Canopie', ['recIndia'], { [M.status]: 'For-Profit pivot' })], website: [websiteRow('recW1', 'Canopie', 'recM1', ['India'])], places, cohorts }, { config: cfg, overrideFieldIds: {} });
  assert.equal(p.updates.length, 1);
  assert.deepEqual(p.updates[0].fields.map((f) => f.fieldId), [F.status]);
});

test('plan: new select options and missing continents are listed', () => {
  const continents = { countries: { India: 'Asia' } };
  const p = planSync({ mel: [melRecord('recM1', 'A', ['recVN', 'recIndia'])], website: [websiteRow('recW1', 'A', 'recM1', [])], places, cohorts, countryOptions: ['India'] }, { config, overrideFieldIds: {}, continents });
  assert.deepEqual(p.newOptions, ['Vietnam']);
  assert.deepEqual(p.missingContinents, ['Vietnam']);
});

test('output: redaction names only rows that are already public; the Slack digest keeps names', () => {
  const mel = [melRecord('recM1', 'Public One', ['recIndia']), melRecord('recM2', 'Secret One', ['recUK'], { [M.undercover]: 'Yes' })];
  const website = [websiteRow('recW1', 'Public One', 'recM1', []), websiteRow('recW2', 'Secret One', 'recM2', [], { [F.undercover]: true })];
  const p = plan(mel, website);
  const redacted = formatPlan(p, { redact: true }).join('\n');
  assert.match(redacted, /Public One \(recW1\)/);
  assert.doesNotMatch(redacted, /Secret One/);
  assert.match(redacted, /\[hidden\] recW2/);
  assert.doesNotMatch(redacted, /United Kingdom/); // the hidden row's values are hidden too
  const open = formatPlan(p, { redact: false }).join('\n');
  assert.match(open, /Secret One \(recW2\)/);
  assert.match(formatDigest(p), /Secret One/);
  assert.equal(label({ name: 'X', websiteId: 'recX', hidden: true }, true), '[hidden] recX');
});

test('writes: a base registered as read-only is refused before any request is made', async () => {
  forbidWrites('appREADONLY000001');
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, json: async () => ({ records: [] }) };
  };
  await assert.rejects(() => patchRecords({ token: 't', baseId: 'appREADONLY000001', tableId: 'tblX', records: [{ id: 'rec1', fields: {} }], fetchImpl }), /read-only/);
  assert.equal(called, false);
});

test('writes: PATCH goes out in batches of 10 with typecast and the record ids', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ records: JSON.parse(init.body).records }) };
  };
  const records = Array.from({ length: 12 }, (_, i) => ({ id: `rec${i}`, fields: { fldA: ['India'] } }));
  const out = await patchRecords({ token: 't', baseId: 'appWRITABLE000001', tableId: 'tblW', records, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(JSON.parse(calls[0].init.body).typecast, true);
  assert.equal(JSON.parse(calls[0].init.body).records.length, 10);
  assert.equal(out.length, 12);
});

/* ------------------------------------------------------------------- state field + drift flags for manual rows */

const STATE = 'fldMELstate000001';
const planS = (mel, website, opts = {}) => planSync({ mel, website, places, cohorts }, { config, overrideFieldIds: { countries: OVERRIDE }, stateFieldIds: { countries: STATE }, ...opts });

test('state: every linked row gets MEL\'s derived list remembered; blank MEL is remembered as "(none)"', () => {
  const p = planS([melRecord('recM1', 'A', ['recUK', 'recBihar']), melRecord('recM2', 'B', [])], [websiteRow('recW1', 'A', 'recM1', ['India', 'United Kingdom']), websiteRow('recW2', 'B', 'recM2', ['India'])]);
  assert.deepEqual(p.stateUpdates.map((x) => [x.websiteId, x.fieldId, x.after]), [['recW1', STATE, 'India, United Kingdom'], ['recW2', STATE, '(none)']]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.drift.length, 0);
  assert.ok(!hasChanges(p), 'bookkeeping alone is not a change worth a digest');
});

test('state: no bookkeeping write when the remembered value is current', () => {
  const p = planS([melRecord('recM1', 'A', ['recUK'])], [websiteRow('recW1', 'A', 'recM1', ['United Kingdom'], { [STATE]: 'United Kingdom' })]);
  assert.equal(p.stateUpdates.length, 0);
});

test('drift: a manual row is flagged when MEL changed, with additions and removals, and Countries is not written', () => {
  const p = planS([melRecord('recM1', 'Animal Ask', ['recUK', 'recIndia'])], [websiteRow('recW1', 'Animal Ask', 'recM1', ['Global'], { [OVERRIDE]: true, [STATE]: 'Vietnam, United Kingdom' })]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.skipped.length, 1);
  assert.equal(p.drift.length, 1);
  const d = p.drift[0];
  assert.deepEqual(d.added, ['India']);
  assert.deepEqual(d.removed, ['Vietnam']);
  assert.equal(d.melText, 'India, United Kingdom');
  assert.equal(d.websiteText, 'Global');
  assert.equal(d.overrideName, 'Countries: manual');
  assert.equal(p.stateUpdates[0].after, 'India, United Kingdom');
  assert.ok(hasChanges(p), 'a drift flag is a change worth a digest');
});

test('drift: not flagged on the first run (no remembered value yet) nor while MEL is unchanged', () => {
  const first = planS([melRecord('recM1', 'A', ['recUK'])], [websiteRow('recW1', 'A', 'recM1', ['Global'], { [OVERRIDE]: true })]);
  assert.equal(first.drift.length, 0);
  assert.equal(first.stateUpdates.length, 1);
  const same = planS([melRecord('recM1', 'A', ['recUK'])], [websiteRow('recW1', 'A', 'recM1', ['Global'], { [OVERRIDE]: true, [STATE]: 'United Kingdom' })]);
  assert.equal(same.drift.length, 0);
  assert.equal(same.stateUpdates.length, 0);
  assert.ok(!hasChanges(same));
});

test('drift: a manual row whose MEL list was emptied is flagged as removals', () => {
  const p = planS([melRecord('recM1', 'A', [])], [websiteRow('recW1', 'A', 'recM1', ['Global'], { [OVERRIDE]: true, [STATE]: 'United Kingdom' })]);
  assert.equal(p.drift.length, 1);
  assert.deepEqual(p.drift[0].removed, ['United Kingdom']);
  assert.deepEqual(p.drift[0].added, []);
  assert.equal(p.stateUpdates[0].after, '(none)');
});

test('drift: rows without the override are never flagged; they are updated instead', () => {
  const p = planS([melRecord('recM1', 'A', ['recUK'])], [websiteRow('recW1', 'A', 'recM1', ['Global'], { [STATE]: 'Vietnam' })]);
  assert.equal(p.drift.length, 0);
  assert.equal(p.updates.length, 1);
  assert.equal(p.stateUpdates.length, 1);
});

test('drift: without a state field nothing is remembered and nothing is flagged', () => {
  const p = plan([melRecord('recM1', 'A', ['recUK'])], [websiteRow('recW1', 'A', 'recM1', ['Global'], { [OVERRIDE]: true })]);
  assert.equal(p.stateUpdates.length, 0);
  assert.equal(p.drift.length, 0);
});

test('state: a created row carries the remembered MEL value too', () => {
  const p = planS([melRecord('recM9', 'New', ['recIndia'])], []);
  assert.equal(p.creates[0].fields[STATE], 'India');
  const blank = planS([melRecord('recM8', 'Blank', [])], []);
  assert.equal(blank.creates[0].fields[STATE], '(none)');
});

test('output: drift flags appear in the plan, the digest (with the untick instruction) and the step summary; hidden rows stay hidden', () => {
  const mel = [melRecord('recM1', 'Animal Ask', ['recUK']), melRecord('recM2', 'Secret', ['recIndia'], { [M.undercover]: 'Yes' })];
  const website = [
    websiteRow('recW1', 'Animal Ask', 'recM1', ['Global'], { [OVERRIDE]: true, [STATE]: 'Vietnam' }),
    websiteRow('recW2', 'Secret', 'recM2', ['Global'], { [OVERRIDE]: true, [STATE]: 'Vietnam', [F.undercover]: true }),
  ];
  const p = planS(mel, website);
  assert.equal(p.drift.length, 2);
  const digest = formatDigest(p);
  assert.match(digest, /2 flagged/);
  assert.match(digest, /Animal Ask: MEL added United Kingdom; MEL removed Vietnam\. MEL now lists United Kingdom; the website shows Global/);
  assert.match(digest, /Hand-curated rows where MEL changed/);
  assert.match(digest, /Untick "Countries: manual"/);
  assert.match(digest, /Secret/);
  const open = formatPlan(p, { redact: false }).join('\n');
  assert.match(open, /added in MEL: +United Kingdom/);
  const redacted = formatPlan(p, { redact: true }).join('\n');
  assert.match(redacted, /Animal Ask \(recW1\)/);
  assert.doesNotMatch(redacted, /Secret/);
  assert.doesNotMatch(redacted, /India/);
  const summary = formatStepSummary(p, { redact: true });
  assert.match(summary, /manual rows flagged \(MEL changed\) \| 2/);
  assert.match(summary, /\[hidden\] recW2 \| Countries \| \(values hidden\)/);
});

test('state field: resolved by name as a long text field; wrong type or absence counts as missing', () => {
  const schema = (fields) => ({ tables: [{ id: config.website.table.id, name: 'Website', fields }] });
  assert.deepEqual(resolveStateFields(schema([{ id: 'fldS1', name: 'Countries (from MEL)', type: 'multilineText' }]), config).ids, { countries: 'fldS1' });
  assert.deepEqual(resolveStateFields(schema([]), config).missing, ['Countries (from MEL)']);
  assert.match(resolveStateFields(schema([{ id: 'fldS1', name: 'Countries (from MEL)', type: 'checkbox' }]), config).missing[0], /not a long text field/);
});

test('state field: the real id in config/sync.json works as the renamed-field fallback', () => {
  const schema = (fields) => ({ tables: [{ id: config.website.table.id, name: 'Website', fields }] });
  const renamed = resolveStateFields(schema([{ id: 'fldA4RUnM2BetxaRt', name: 'Countries from MEL (old)', type: 'multilineText' }]), config);
  assert.deepEqual(renamed.ids, { countries: 'fldA4RUnM2BetxaRt' });
  assert.match(renamed.warnings[0], /no field named "Countries \(from MEL\)"/);
});

test('first real run: the state field empty on every row means no baseline, so nothing is flagged and every linked row gets one', () => {
  const mel = [melRecord('recM1', 'Animal Ask', ['recUK']), melRecord('recM2', 'B', ['recIndia'])];
  const website = [websiteRow('recW1', 'Animal Ask', 'recM1', ['Global'], { [OVERRIDE]: true }), websiteRow('recW2', 'B', 'recM2', ['India'])];
  const p = planS(mel, website);
  assert.equal(p.drift.length, 0);
  assert.deepEqual(p.stateUpdates.map((s) => s.websiteId).sort(), ['recW1', 'recW2']);
  assert.equal(p.updates.length, 0);
});

test('digest: plain-English header and change lines, in the wording Aidan asked for', () => {
  const p = plan([melRecord('recM1', 'Radius Institute for Road Safety', ['recUK', 'recIndia'])], [websiteRow('recW1', 'Radius Institute for Road Safety', 'recM1', ['United Kingdom'])]);
  const digest = formatDigest(p, { mode: 'apply', when: new Date('2026-10-17T03:17:00Z') });
  assert.match(digest, /^Sync between charity directory on website and MEL airtable \(2026-10-17 \| 1 updated, 0 created, 0 flagged, 0 skipped, 0 warnings\)/);
  assert.match(digest, /• Radius Institute for Road Safety: Implementing countries changed from United Kingdom to India and United Kingdom/);
  assert.match(formatDigest(p, { mode: 'dry-run' }), /dry run, nothing was changed/);
  assert.equal(humanList(['A']), 'A');
  assert.equal(humanList(['A', 'B']), 'A and B');
  assert.equal(humanList(['A', 'B', 'C']), 'A, B and C');
  assert.equal(describeChange({ key: 'countries', before: [], after: ['Kenya'] }), 'Implementing countries set to Kenya');
  assert.equal(describeChange({ key: 'status', label: 'Status', before: 'Active', after: 'Shutdown' }), 'Status changed from Active to Shutdown');
});
