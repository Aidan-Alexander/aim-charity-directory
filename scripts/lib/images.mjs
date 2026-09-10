// Download Airtable attachments (their URLs expire within hours) and rehost them under public/img.
// Files are named <slug>-<content hash>.<ext> so a changed image gets a new URL (no stale caches).

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify } from './transform.mjs';

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function extensionFor(att) {
  if (EXT_BY_TYPE[att.type]) return EXT_BY_TYPE[att.type];
  const m = /\.([a-z0-9]{2,5})$/i.exec(att.filename || '');
  return m ? m[1].toLowerCase() : 'bin';
}

/**
 * Mutates `data`: replaces every attachment descriptor ({url,...}) with {src,width,height} or null.
 * With `skip: true` nothing is downloaded and every attachment becomes null (never an expiring URL).
 */
export async function rehostImages(data, { outDir, skip = false, fetchImpl = fetch, log = () => {} }) {
  const dirs = { logos: path.join(outDir, 'img', 'logos'), founders: path.join(outDir, 'img', 'founders') };
  const warnings = [];
  let count = 0;

  if (!skip) {
    for (const dir of Object.values(dirs)) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
  }

  async function rehost(att, kind, baseName) {
    if (!att) return null;
    if (skip) return null;
    let buf;
    try {
      const res = await fetchImpl(att.url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      warnings.push(`Could not download ${kind} image for ${baseName}: ${err.message}`);
      return null;
    }
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
    const file = `${baseName}-${hash}.${extensionFor(att)}`;
    await writeFile(path.join(dirs[kind], file), buf);
    count += 1;
    log(`  ${kind}/${file} (${(buf.length / 1024).toFixed(0)} kB)`);
    return { src: `img/${kind}/${file}`, width: att.width, height: att.height };
  }

  for (const charity of data.charities) {
    charity.logo = await rehost(charity.logo, 'logos', charity.id);
    for (const founder of charity.founders) {
      founder.photo = await rehost(founder.photo, 'founders', `${charity.id}--${slugify(founder.name)}`);
    }
  }
  if (skip) {
    const n = data.charities.reduce((s, c) => s + (c.logo ? 1 : 0) + c.founders.filter((f) => f.photo).length, 0);
    if (n) warnings.push(`--skip-images: ${n} attachment(s) not rehosted; published as null`);
  }
  return { count, warnings };
}
