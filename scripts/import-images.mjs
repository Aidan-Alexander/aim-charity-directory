#!/usr/bin/env node
// One-off importer: match a folder tree of processed logos/photos to the published charities and
// founders, and copy them into assets/ under the build's naming convention.
//
//   node scripts/import-images.mjs "<source dir>"            dry run: print the matching report
//   node scripts/import-images.mjs "<source dir>" --apply    copy matched files into assets/
//
// Expected source layout (what the Drive "cropped and compressed" folder looks like):
//   <year>/<charity folder>/<files>.webp   with founder photos named after the founder and one or
//   more logo files. Folder and file names are matched fuzzily (accents, nicknames, typos, acronyms);
//   anything ambiguous is reported instead of guessed. Fix leftovers via config/image-import-overrides.json:
//   { "<year>/<folder>/<file>": { "charity": "<charity id>", "founder": "<founder name>" } }
//   { "<year>/<folder>/<file>": { "charity": "<charity id>", "logo": true } }
//   { "<year>/<folder>/<file>": { "skip": true } }
//   { "<year>/<folder>": { "charity": "<charity id>" } }        (folder-level charity override)
//   { "<year>/<folder>": { "skip": true } }                      (ignore a whole folder)

import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify } from './lib/transform.mjs';
import { ASSET_EXTENSIONS, imageSize } from './lib/images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sourceDir = args.find((a) => !a.startsWith('--'));
if (!sourceDir) {
  console.error('Usage: node scripts/import-images.mjs "<source dir>" [--apply] [--data FILE]');
  process.exit(1);
}
const dataFile = args.includes('--data') ? args[args.indexOf('--data') + 1] : 'public/charities.json';

const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (s) => fold(s).replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
const FILE_STOP = new Set(['dr', 'picture', 'photo', 'copy', 'of', 'headshot', 'image']);
const NAME_STOP = new Set(['logo', 'charity', 'final', 'large', 'full', 'primary', 'new', 'copy', 'of']);
const PHOTO_SIZE = 512; // px, the size the circle-crop pipeline produces
const NICKNAMES = {
  tom: 'thomas', will: 'william', kris: 'kristina', jen: 'jennifer', matt: 'matthew', dan: 'daniel', sam: 'samuel',
  ben: 'benjamin', mike: 'michael', joey: 'joseph', nick: 'nicholas', chris: 'christopher', alex: 'alexander', kate: 'katherine',
};

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

function matchCharity(folderName, charities) {
  const f = fold(folderName).replace(/\(\d+\)/g, '').trim();
  const fslug = slugify(f);
  const ftoks = tokens(f).filter((t) => !NAME_STOP.has(t));
  let best = null, bestScore = 0;
  for (const c of charities) {
    const acr = (/\(([^)]+)\)\s*$/.exec(c.name) || [])[1];
    let score = 0;
    if (fslug === c.id) score = 1;
    else if (acr && fold(acr) === f) score = 0.98;
    else if (acr && f.length >= 4 && sim(fold(acr), f) >= 0.8) score = 0.9;
    else if (c.id.startsWith(`${fslug}-`) || fslug.startsWith(`${c.id}-`)) score = 0.9;
    else {
      const ntoks = tokens(c.name).filter((t) => !NAME_STOP.has(t));
      const inter = ftoks.filter((t) => ntoks.includes(t)).length;
      const jacc = inter / new Set([...ftoks, ...ntoks]).size;
      score = Math.max(jacc, sim(fslug, c.id) >= 0.85 ? 0.85 : 0);
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.6 ? { charity: best, score: bestScore } : null;
}

function matchFounder(fileBase, founders) {
  const ft = tokens(fileBase).filter((t) => !FILE_STOP.has(t));
  if (!ft.length || ft.every((t) => /^\d+$/.test(t))) return null;
  let best = null, bestScore = 0;
  for (const f of founders) {
    const nt = tokens(f.name);
    const last = nt[nt.length - 1];
    const tokMatch = (t) => nt.some((n) => n === t || NICKNAMES[t] === n || (t.length >= 3 && n.startsWith(t)) || sim(n, t) >= 0.8);
    let score = 0;
    if (ft.join(' ') === nt.join(' ')) score = 1;
    else if (ft.every(tokMatch)) score = 0.9 - 0.05 * Math.max(0, nt.length - ft.length);
    else if ((ft[0] === nt[0] || NICKNAMES[ft[0]] === nt[0]) && ft.filter(tokMatch).length / ft.length >= 0.5) score = 0.8; // "Uttej K" -> Uttej Sai
    else if (ft.some((t) => t === last || sim(t, last) >= 0.85)) score = 0.7;
    else if (sim(ft.join(' '), nt.join(' ')) >= 0.75) score = 0.65;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return bestScore >= 0.6 ? { founder: best, score: bestScore } : null;
}

function logoScore(fileBase, charity) {
  const f = fold(fileBase);
  let s = 0;
  if (/logo/.test(f)) s += 1;
  if (/primary|full|final|main/.test(f)) s += 2;
  if (/colou?r|on white/.test(f)) s += 1;
  if (/white on|reverse|inverse|mono|brandmark|icon|large|copy of/.test(f)) s -= 3;
  const ctoks = tokens(charity.name).filter((t) => !NAME_STOP.has(t));
  if (ctoks.some((t) => f.includes(t))) s += 1;
  return s;
}

async function main() {
  const data = JSON.parse(await readFile(path.resolve(ROOT, dataFile), 'utf8'));
  let overrides = {};
  try { overrides = JSON.parse(await readFile(path.join(ROOT, 'config', 'image-import-overrides.json'), 'utf8')); } catch { /* none */ }
  const charities = data.charities;
  const byId = new Map(charities.map((c) => [c.id, c]));
  const plan = []; // { from, to, kind, charity, founder }
  const problems = [];
  const foldersSeen = new Map(); // charity id -> folder names
  const source = path.resolve(sourceDir);

  const years = (await readdir(source, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  for (const year of years) {
    const folders = (await readdir(path.join(source, year.name), { withFileTypes: true })).filter((e) => e.isDirectory());
    for (const folder of folders) {
      const relFolder = `${year.name}/${folder.name}`;
      const files = (await readdir(path.join(source, year.name, folder.name), { withFileTypes: true }))
        .filter((e) => e.isFile() && !e.name.startsWith('.') && ASSET_EXTENSIONS.includes(path.extname(e.name).slice(1).toLowerCase()));
      const folderOverride = overrides[relFolder];
      if (folderOverride && folderOverride.skip) continue;
      const m = folderOverride && folderOverride.charity ? { charity: byId.get(folderOverride.charity), score: 1 } : matchCharity(folder.name, charities);
      if (!m || !m.charity) {
        problems.push(`No charity matches folder "${relFolder}" (${files.length} files). Add {"${relFolder}": {"charity": "<id>"}} to config/image-import-overrides.json or skip.`);
        continue;
      }
      const c = m.charity;
      foldersSeen.set(c.id, [...(foldersSeen.get(c.id) || []), relFolder]);
      const logoCandidates = [];
      const founderHits = new Map();
      const unnamedPhotos = [];
      for (const file of files) {
        const rel = `${relFolder}/${file.name}`;
        const base = path.basename(file.name, path.extname(file.name));
        const ext = path.extname(file.name).slice(1).toLowerCase();
        const size = imageSize(await readFile(path.join(source, year.name, folder.name, file.name)));
        // Processed headshots are exactly PHOTO_SIZE square; logos are anything else (many are padded 1000x1000 squares).
        const isPhotoSize = !!size && size.width === PHOTO_SIZE && size.height === PHOTO_SIZE;
        const nearSquare = !!size && Math.abs(size.width / size.height - 1) < 0.05;
        const ov = overrides[rel];
        if (ov && ov.skip) continue;
        if (ov && ov.logo) { logoCandidates.push({ rel, base, ext, score: 100 }); continue; }
        if (ov && ov.founder) {
          const f = c.founders.find((x) => x.name === ov.founder);
          if (!f) { problems.push(`Override for "${rel}" names founder "${ov.founder}" who is not on ${c.name}`); continue; }
          founderHits.set(f.name, { rel, ext, score: 1 });
          continue;
        }
        let fm = null;
        if (!/logo/i.test(base)) {
          fm = matchFounder(base, c.founders);
          if (fm && !isPhotoSize && !(nearSquare && fm.score >= 0.9)) fm = null; // odd-sized file: only trust a strong name match
        }
        if (fm) {
          const prev = founderHits.get(fm.founder.name);
          if (!prev || fm.score > prev.score) founderHits.set(fm.founder.name, { rel, ext, score: fm.score });
          else problems.push(`"${rel}" also looks like ${fm.founder.name} (already matched from "${prev.rel}")`);
        } else if (isPhotoSize) {
          unnamedPhotos.push({ rel, ext, size });
        } else {
          logoCandidates.push({ rel, base, ext, score: logoScore(base, c) });
        }
      }
      // A square headshot whose name matches nobody: assign it only when exactly one founder is still without a photo.
      for (const u of unnamedPhotos) {
        const missing = c.founders.filter((f) => !founderHits.has(f.name));
        if (missing.length === 1 && unnamedPhotos.length === 1) {
          founderHits.set(missing[0].name, { rel: u.rel, ext: u.ext, score: 0.6, inferred: true });
        } else {
          problems.push(`"${u.rel}" is a ${u.size.width}x${u.size.height} headshot but matches no founder name on ${c.name} (${missing.map((f) => f.name).join(', ') || 'all founders already have photos'})`);
        }
      }
      for (const [name, hit] of founderHits) {
        plan.push({ from: hit.rel, to: `assets/founders/${c.id}/${slugify(name)}.${hit.ext}`, kind: 'photo', charity: c.name, founder: name, score: hit.score, inferred: !!hit.inferred });
      }
      for (const f of c.founders) if (!founderHits.has(f.name)) problems.push(`No photo found for ${f.name} in "${relFolder}" (${c.name})`);
      logoCandidates.sort((a, b) => b.score - a.score || a.base.length - b.base.length);
      if (logoCandidates.length) {
        const pick = logoCandidates[0];
        plan.push({ from: pick.rel, to: `assets/logos/${c.id}.${pick.ext}`, kind: 'logo', charity: c.name, alternatives: logoCandidates.slice(1).map((x) => x.rel) });
      } else {
        problems.push(`No logo candidate in "${relFolder}" (${c.name})`);
      }
    }
  }
  for (const c of charities) if (!foldersSeen.has(c.id)) problems.push(`No source folder for ${c.name} (id ${c.id})`);
  for (const [id, folders] of foldersSeen) if (folders.length > 1) problems.push(`Charity ${id} matched several folders: ${folders.join(', ')}`);

  console.log(`Source: ${source}\nData:   ${dataFile} (${charities.length} charities)\n`);
  for (const p of plan) {
    const tag = p.kind === 'logo' ? 'LOGO ' : 'PHOTO';
    const extra = p.kind === 'logo' && p.alternatives.length ? `   [also: ${p.alternatives.join(' | ')}]` : (p.inferred ? '   (INFERRED: only founder without a photo)' : (p.score < 0.9 ? `   (fuzzy ${p.score.toFixed(2)})` : ''));
    console.log(`${tag} ${p.from}  ->  ${p.to}${extra}`);
  }
  console.log(`\n${plan.filter((p) => p.kind === 'logo').length} logos, ${plan.filter((p) => p.kind === 'photo').length} photos matched.`);
  if (problems.length) {
    console.log(`\n${problems.length} thing(s) to check:`);
    for (const p of problems) console.log(`  - ${p}`);
  }
  if (apply) {
    for (const p of plan) {
      const dest = path.join(ROOT, p.to);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(source, p.from), dest);
    }
    console.log(`\nCopied ${plan.length} files into assets/.`);
  } else {
    console.log('\nDry run only. Re-run with --apply to copy the files.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
