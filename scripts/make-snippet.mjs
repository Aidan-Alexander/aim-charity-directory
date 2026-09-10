#!/usr/bin/env node
// Generate the Squarespace code-block snippet: widget CSS + JS + an inline snapshot of
// public/charities.json, plus the live URL the widget refreshes from in the background.
//
//   node scripts/make-snippet.mjs --base https://<user>.github.io/aim-charity-directory/
//   node scripts/make-snippet.mjs --base ... --demo path/to/preview.html   (also write a self-contained demo page)
//
// Output: public/snippet.html (paste its whole content into one Squarespace code block).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { base: process.env.PAGES_BASE_URL || '', out: 'public/snippet.html', demo: null, data: 'public/charities.json' };
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === '--base') args.base = process.argv[++i];
  else if (a === '--out') args.out = process.argv[++i];
  else if (a === '--demo') args.demo = process.argv[++i];
  else if (a === '--data') args.data = process.argv[++i];
  else throw new Error(`Unknown argument: ${a}`);
}
if (args.base && !args.base.endsWith('/')) args.base += '/';

const css = (await readFile(path.join(ROOT, 'public', 'widget.css'), 'utf8')).trim();
const js = (await readFile(path.join(ROOT, 'public', 'widget.js'), 'utf8')).trim();
const data = JSON.parse(await readFile(path.resolve(ROOT, args.data), 'utf8'));

// Safe to embed inside <script>: no "</script" or "<!--" sequences can survive this escaping.
const inlineData = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const mountOptions = [`data:d`];
if (args.base) {
  mountOptions.push(`dataUrl:${JSON.stringify(`${args.base}charities.json`)}`);
  mountOptions.push(`imageBase:${JSON.stringify(args.base)}`);
}

const snippet = `<!-- AIM charity directory. Generated ${data.generatedAt} from ${data.charities.length} charities.
     Do not edit by hand: re-generate with "node scripts/make-snippet.mjs" and paste the whole file
     into the Squarespace code block. The widget renders the inline snapshot immediately, then fetches
     ${args.base ? `${args.base}charities.json` : '(no live URL configured)'} and re-renders only if it changed. -->
<div id="aim-dir" class="aim-dir"></div>
<style>
${css}
</style>
<script>
${js}
</script>
<script>
(function(){var d=${inlineData};window.AimDirectory.mount(document.getElementById('aim-dir'),{${mountOptions.join(',')}});})();
</script>
`;
await writeFile(path.resolve(ROOT, args.out), snippet);
console.log(`Wrote ${args.out} (${(Buffer.byteLength(snippet) / 1024).toFixed(0)} kB, ${data.charities.length} charities inline${args.base ? `, live: ${args.base}charities.json` : ', no live URL'})`);

if (args.demo) {
  // A page that stands in for the Squarespace page around the code block (cream background,
  // the site's likely fonts). Written without <html>/<head>/<body> so it can also be published as-is.
  const demo = `<title>AIM Charity Directory</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display&family=Nunito+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; background: #FCF6F1; }
  body { color: #241A1B; font-family: "Nunito Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 15px; }
  .page { max-width: 1280px; margin: 0 auto; padding: 48px 40px 80px; }
  .note { margin: 0 0 28px; font-size: 13px; color: #7A6866; }
  @media (max-width: 899px) { .page { padding: 32px 22px 56px; } }
</style>
<div class="page">
<p class="note">Preview of the charity directory code block. The cream page, its padding and the fonts stand in for the Squarespace page. Data snapshot: ${data.generatedAt}.</p>
${snippet}
</div>
`;
  await writeFile(path.resolve(ROOT, args.demo), demo);
  console.log(`Wrote demo page ${args.demo}`);
}
