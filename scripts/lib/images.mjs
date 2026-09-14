// Image sourcing for the directory. Two sources, in this order of precedence:
//   1. an Airtable attachment on the row (downloaded; Airtable attachment URLs expire within hours)
//   2. a file committed to the repo under assets/:
//        assets/logos/<charity id>.<ext>                       e.g. assets/logos/animal-ask.webp
//        assets/founders/<charity id>/<founder slug>.<ext>     e.g. assets/founders/animal-ask/amy-odene.webp
//      (<charity id> is the "id" in charities.json; <founder slug> is the founder's name slugified;
//       ext may be webp, png, svg, jpg, jpeg, avif or gif)
// Output files are written to public/img/<logos|founders>/<name>-<content hash>.<ext>, so a changed
// image gets a new URL and stale browser caches are never a problem.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
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
export const ASSET_EXTENSIONS = ['webp', 'png', 'svg', 'jpg', 'jpeg', 'avif', 'gif'];

/** Pixel size of a PNG, JPEG, GIF or WebP buffer, or null (SVG/AVIF/unknown). */
export function imageSize(buf) {
  if (!buf || buf.length < 30) return null;
  if (buf.toString('ascii', 1, 4) === 'PNG') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (fourcc === 'VP8L') {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)) };
    }
    if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function extensionFor(att) {
  if (EXT_BY_TYPE[att.type]) return EXT_BY_TYPE[att.type];
  const m = /\.([a-z0-9]{2,5})$/i.exec(att.filename || '');
  return m ? m[1].toLowerCase() : 'bin';
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const DEFAULT_SIZES = { logo: { maxWidth: 480, maxHeight: 240, trim: true }, photo: { size: 160 }, quality: 85 };

/**
 * Re-encode an image for the card. Logos: trim uniform borders (transparent or the corner colour),
 * fit inside the logo box, never enlarge. Photos: square cover crop. Output is WebP; SVG/GIF pass through.
 * Returns { buf, ext, width, height, note }.
 */
export async function processImage(buf, kind, ext, sizes = DEFAULT_SIZES) {
  if (ext === 'svg' || ext === 'gif') {
    const size = imageSize(buf);
    return { buf, ext, width: size ? size.width : null, height: size ? size.height : null, note: 'kept as-is' };
  }
  try {
    let img = sharp(buf, { animated: false }).rotate();
    if (kind === 'logos') {
      const cfg = sizes.logo || DEFAULT_SIZES.logo;
      if (cfg.trim !== false) {
        // The logo panel is white, so flattening onto white is invisible and lets one pass trim both
        // transparent margins and white padding (padded boxes, white discs). A second pass catches a
        // thin border line left by the first.
        try {
          let trimmed = await img.flatten({ background: '#ffffff' }).trim({ background: '#ffffff', threshold: cfg.trimThreshold || 24 }).toBuffer();
          try { trimmed = await sharp(trimmed).trim({ background: '#ffffff', threshold: cfg.trimThreshold || 24 }).toBuffer(); } catch { /* nothing more to trim */ }
          const tm = await sharp(trimmed).metadata();
          if (tm.width >= 24 && tm.height >= 24) img = sharp(trimmed);
        } catch {
          img = sharp(buf).rotate(); // entirely one colour, or trim unsupported: keep untrimmed
        }
      }
      img = img.resize({ width: cfg.maxWidth, height: cfg.maxHeight, fit: 'inside', withoutEnlargement: true });
    } else {
      const cfg = sizes.photo || DEFAULT_SIZES.photo;
      img = img.resize(cfg.size, cfg.size, { fit: 'cover', position: 'centre' });
    }
    const out = await img.webp({ quality: sizes.quality || 85, alphaQuality: 90, effort: 5 }).toBuffer();
    const meta = await sharp(out).metadata();
    return { buf: out, ext: 'webp', width: meta.width || null, height: meta.height || null, note: `${(buf.length / 1024).toFixed(0)} kB -> ${(out.length / 1024).toFixed(0)} kB` };
  } catch (err) {
    const size = imageSize(buf);
    return { buf, ext, width: size ? size.width : null, height: size ? size.height : null, note: `not processed (${err.message})` };
  }
}

/** Find assets/<...>/<base>.<ext> for any allowed extension. Returns { file, ext } or null. */
async function findAsset(dir, base) {
  const entries = await listDir(dir);
  for (const ext of ASSET_EXTENSIONS) {
    const name = `${base}.${ext}`;
    if (entries.some((e) => e.isFile() && e.name === name)) return { file: path.join(dir, name), ext };
  }
  return null;
}

/**
 * Mutates `data`: every logo/photo becomes { src, width, height } or null.
 * - Attachments are downloaded unless `skip` is set (then they count as missing).
 * - Repo assets are always used when no attachment is available.
 * Returns { count, warnings, used } where `used` lists the asset files that were consumed.
 */
export async function rehostImages(data, { outDir, assetsDir = null, skip = false, sizes = DEFAULT_SIZES, fetchImpl = fetch, log = () => {} }) {
  const dirs = { logos: path.join(outDir, 'img', 'logos'), founders: path.join(outDir, 'img', 'founders') };
  const warnings = [];
  const used = new Set();
  let count = 0;
  let fromAirtable = 0;
  let fromAssets = 0;

  for (const dir of Object.values(dirs)) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }

  async function write(kind, baseName, rawBuf, rawExt, meta) {
    const processed = await processImage(rawBuf, kind, rawExt, sizes);
    const hash = createHash('sha256').update(processed.buf).digest('hex').slice(0, 10);
    const file = `${baseName}-${hash}.${processed.ext}`;
    await writeFile(path.join(dirs[kind], file), processed.buf);
    count += 1;
    log(`  ${kind}/${file} (${meta}; ${processed.note})`);
    return { src: `img/${kind}/${file}`, width: processed.width, height: processed.height };
  }

  async function fromAttachment(att, kind, baseName) {
    if (!att || skip) return null;
    try {
      const res = await fetchImpl(att.url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fromAirtable += 1;
      return write(kind, baseName, buf, extensionFor(att), 'Airtable');
    } catch (err) {
      warnings.push(`Could not download ${kind} image for ${baseName}: ${err.message}`);
      return null;
    }
  }

  async function fromAsset(kind, assetDir, assetBase, outBase) {
    if (!assetsDir) return null;
    const found = await findAsset(assetDir, assetBase);
    if (!found) return null;
    used.add(found.file);
    fromAssets += 1;
    return write(kind, outBase, await readFile(found.file), found.ext, `assets/${path.relative(assetsDir, found.file)}`);
  }

  for (const charity of data.charities) {
    charity.logo =
      (await fromAttachment(charity.logo, 'logos', charity.id)) ||
      (await fromAsset('logos', assetsDir && path.join(assetsDir, 'logos'), charity.id, charity.id));
    for (const founder of charity.founders) {
      const founderSlug = slugify(founder.name);
      founder.photo =
        (await fromAttachment(founder.photo, 'founders', `${charity.id}--${founderSlug}`)) ||
        (await fromAsset('founders', assetsDir && path.join(assetsDir, 'founders', charity.id), founderSlug, `${charity.id}--${founderSlug}`));
    }
  }

  // Report repo assets that no published charity/founder uses (renamed charity, typo, or unpublished row).
  if (assetsDir) {
    const stale = [];
    for (const e of await listDir(path.join(assetsDir, 'logos'))) {
      const f = path.join(assetsDir, 'logos', e.name);
      if (e.isFile() && !e.name.startsWith('.') && !used.has(f)) stale.push(path.relative(assetsDir, f));
    }
    for (const d of await listDir(path.join(assetsDir, 'founders'))) {
      if (!d.isDirectory()) continue;
      for (const e of await listDir(path.join(assetsDir, 'founders', d.name))) {
        const f = path.join(assetsDir, 'founders', d.name, e.name);
        if (e.isFile() && !e.name.startsWith('.') && !used.has(f)) stale.push(path.relative(assetsDir, f));
      }
    }
    for (const s of stale) warnings.push(`Unused asset (no published charity/founder matches its name): assets/${s}`);
  }
  log(`  images: ${fromAirtable} from Airtable attachments, ${fromAssets} from repo assets`);
  return { count, warnings, used: [...used] };
}
