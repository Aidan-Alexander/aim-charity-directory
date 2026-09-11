#!/usr/bin/env node
// Build public/charities.json (+ rehosted images) from the AIM Website Content Airtable base.
//
//   node scripts/build.mjs                      live: reads AIRTABLE_TOKEN from the environment
//   node scripts/build.mjs --dump-raw raw       also save the raw records (gitignored) for debugging
//   node scripts/build.mjs --from-raw raw       offline: build from a previous dump
//   node scripts/build.mjs --skip-images        don't download Airtable attachments (repo assets are still used)
//   node scripts/build.mjs --out public         output directory (default: public)
//   node scripts/build.mjs --ignore-ready       DESIGN PREVIEW ONLY: don't require "Website ready?" (Undercover/Exclude/Status
//                                               still apply); writes to design/preview-data instead of public

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublishFormula, getToken, listAllRecords } from './lib/airtable.mjs';
import { assertAllowlisted, transform } from './lib/transform.mjs';
import { rehostImages } from './lib/images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { fromRaw: null, dumpRaw: null, skipImages: false, ignoreReady: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from-raw') args.fromRaw = argv[++i];
    else if (a === '--dump-raw') args.dumpRaw = argv[++i];
    else if (a === '--skip-images') args.skipImages = true;
    else if (a === '--ignore-ready') args.ignoreReady = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/build.mjs [--from-raw DIR] [--dump-raw DIR] [--skip-images] [--ignore-ready] [--out DIR]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(path.join(ROOT, 'config', 'publish.json'));
  const continents = await readJson(path.join(ROOT, 'data', 'continents.json'));
  const log = (m) => console.log(m);
  const publishConditions = args.ignoreReady
    ? { ...config.publishConditions, requireChecked: [] }
    : config.publishConditions;
  const outRel = args.out ?? (args.ignoreReady ? 'design/preview-data' : 'public');
  const outDir = path.resolve(ROOT, outRel);
  if (args.ignoreReady) {
    if (outDir === path.resolve(ROOT, 'public')) {
      throw new Error('--ignore-ready output is design preview data and must not go to public/; pass --out elsewhere');
    }
    log('NOTE: --ignore-ready: the "Website ready?" checkbox is not required for this build.');
    log('      Undercover?/Exclude/Status rules still apply. Output is for design preview only.');
  }

  let website;
  let founders;
  if (args.fromRaw) {
    const dir = path.resolve(ROOT, args.fromRaw);
    log(`Reading raw records from ${dir}`);
    website = await readJson(path.join(dir, 'website.json'));
    founders = await readJson(path.join(dir, 'founders.json'));
  } else {
    const token = getToken();
    const { baseId, tables } = config.airtable;
    const formula = buildPublishFormula(publishConditions);
    log(`Fetching from Airtable base ${baseId}`);
    log(`  filter: ${formula}`);
    website = await listAllRecords({
      token,
      baseId,
      tableId: tables.website.id,
      fields: [...config.allowlist.website, ...config.controlFields.website],
      filterByFormula: formula,
      log,
    });
    founders = await listAllRecords({
      token,
      baseId,
      tableId: tables.founders.id,
      fields: [...config.allowlist.founders, ...config.controlFields.founders],
      log,
    });
    if (args.dumpRaw) {
      const dir = path.resolve(ROOT, args.dumpRaw);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'website.json'), JSON.stringify(website, null, 2));
      await writeFile(path.join(dir, 'founders.json'), JSON.stringify(founders, null, 2));
      log(`Raw records written to ${dir} (gitignored; contains only the requested fields)`);
    }
  }

  const { data, warnings, stats } = transform({ website, founders }, { config, continents, ignoreReady: args.ignoreReady });
  data.generatedAt = new Date().toISOString();

  await mkdir(outDir, { recursive: true });
  const images = await rehostImages(data, { outDir, assetsDir: path.join(ROOT, 'assets'), skip: args.skipImages, sizes: config.images, log });
  warnings.push(...images.warnings);

  assertAllowlisted(data);
  const outFile = path.join(outDir, 'charities.json');
  await writeFile(outFile, `${JSON.stringify(data, null, 2)}\n`);

  log('');
  log(`Wrote ${path.relative(ROOT, outFile)}`);
  log(`  charities fetched: ${stats.fetched}, published: ${stats.published}, skipped by publish rules: ${stats.skipped}`);
  const logos = data.charities.filter((c) => c.logo).length;
  const photos = data.charities.reduce((n, c) => n + c.founders.filter((f) => f.photo).length, 0);
  log(`  founders published: ${stats.founders}; with logo: ${logos}/${stats.published}; founder photos: ${photos}/${stats.founders}; image files written: ${images.count}; founders with LinkedIn: ${stats.withLinkedIn}/${stats.founders}`);
  for (const c of data.charities) if (!c.logo) warnings.push(`No logo for ${c.name} (add assets/logos/${c.id}.webp or an Airtable attachment)`);
  for (const c of data.charities) for (const f of c.founders) if (!f.photo) warnings.push(`No photo for ${f.name} (${c.name})`);
  if (warnings.length) {
    log('');
    log(`${warnings.length} warning(s):`);
    for (const w of warnings) log(`  - ${w}`);
  }
  if (!stats.published) {
    console.error('\nNo charities passed the publish rules; refusing to write an empty directory.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
