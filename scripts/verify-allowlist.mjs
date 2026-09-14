#!/usr/bin/env node
// Independent check that public/charities.json contains nothing outside the allowlist.
// Exits 1 on any problem. Run after every build (the GitHub Action does too).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAllowlisted, OUTPUT_KEYS } from './lib/transform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(ROOT, process.argv[2] || 'public/charities.json');

const data = JSON.parse(await readFile(file, 'utf8'));
assertAllowlisted(data);

const config = JSON.parse(await readFile(path.join(ROOT, 'config', 'publish.json'), 'utf8'));
const statuses = new Set(data.charities.map((c) => c.status));
for (const s of statuses) {
  if (!config.publishConditions.statusIn.includes(s)) throw new Error(`Status "${s}" is not publishable`);
}
for (const c of data.charities) {
  for (const t of c.causes) if (!config.causeTags.includes(t)) throw new Error(`Cause tag "${t}" on ${c.id} is not in the agreed list`);
}

console.log(`OK: ${path.relative(ROOT, file)}`);
console.log(`  ${data.charities.length} charities, ${data.charities.reduce((n, c) => n + c.founders.length, 0)} founders`);
const stealth = data.stealth || { total: 0, byCause: {} };
console.log(`  stealth counts (numbers only): total ${stealth.total}; ${Object.entries(stealth.byCause).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
console.log(`  charity keys: ${OUTPUT_KEYS.charity.join(', ')}`);
console.log(`  founder keys: ${OUTPUT_KEYS.founder.join(', ')}`);
console.log('  no Airtable URLs, no Airtable ids, statuses and cause tags within the agreed sets');
