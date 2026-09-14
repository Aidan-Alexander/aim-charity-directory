// Pure transformation: Airtable records (REST shape: { id, fields: {...} }) -> charities.json data.
// No network access here. Only allowlisted fields are ever read from a record.

const EXTRA_TRANSLIT = { ł: 'l', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', þ: 'th', ı: 'i' };

export function slugify(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[łøæœßđþı]/g, (ch) => EXTRA_TRANSLIT[ch] || ch)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Re-check the publish rules in code (the Airtable filter formula is the first line of defence). */
export function isPublishable(fields, conditions) {
  for (const f of conditions.requireChecked || []) if (fields[f] !== true) return false;
  for (const f of conditions.requireUnchecked || []) if (fields[f] === true) return false;
  if (conditions.statusIn?.length) {
    const status = str(fields[conditions.statusField || 'Status']);
    if (!conditions.statusIn.includes(status)) return false;
  }
  return true;
}

function pick(fields, names) {
  const out = {};
  for (const n of names) if (n in fields) out[n] = fields[n];
  return out;
}

/** First attachment of an attachment field, reduced to what the image step needs. */
function firstAttachment(value) {
  const a = arr(value)[0];
  if (!a || typeof a !== 'object' || typeof a.url !== 'string') return null;
  return {
    url: a.url,
    filename: str(a.filename),
    type: str(a.type),
    size: num(a.size),
    width: num(a.width),
    height: num(a.height),
  };
}

/** Accept only real LinkedIn profile/company URLs; anything else becomes null. */
function normaliseLinkedIn(raw) {
  const url = normaliseUrl(raw);
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'linkedin.com' || host.endsWith('.linkedin.com') ? url : null;
  } catch {
    return null;
  }
}

function normaliseUrl(raw) {
  if (!raw) return null;
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).href;
  } catch {
    return null;
  }
}

function uniqueSlug(base, taken) {
  let slug = base || 'charity';
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

function bySortThenName(a, b) {
  const ao = a.sortOrder ?? Number.POSITIVE_INFINITY;
  const bo = b.sortOrder ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return byName(a, b);
}

/** Charities: active ones first, then Sort order, then name. Shutdown/Merged always come last. */
function byStatusSortThenName(a, b) {
  const aa = a.status === 'Active' ? 0 : 1;
  const ba = b.status === 'Active' ? 0 : 1;
  if (aa !== ba) return aa - ba;
  return bySortThenName(a, b);
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort((a, b) => a.localeCompare(b, 'en')).map((k) => [k, obj[k]]));
}

/**
 * @param {{website: object[], founders: object[]}} records  Airtable records (REST shape)
 * @param {{config: object, continents: object, ignoreReady?: boolean}} deps
 *   ignoreReady (design preview only) drops the "Website ready?" requirement; Undercover/Exclude/Status still apply.
 * @returns {{data: object, warnings: string[], stats: object}}
 */
export function transform({ website, founders }, { config, continents, ignoreReady = false }) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const { allowlist, controlFields, causeTags } = config;
  const cond = ignoreReady ? { ...config.publishConditions, requireChecked: [] } : config.publishConditions;
  const continentOf = continents.countries || {};

  // Founders grouped by the record id of the charity they link to.
  const foundersByCharity = new Map();
  for (const rec of founders) {
    const f = pick(rec.fields || {}, [...allowlist.founders, ...controlFields.founders]);
    const name = str(f.Name);
    const links = arr(f['Website charity'])
      .map((l) => (typeof l === 'string' ? l : l && l.id))
      .filter(Boolean);
    if (!name) {
      warn(`Founder record ${rec.id} has no Name; skipped`);
      continue;
    }
    if (!links.length) {
      warn(`Founder "${name}" is not linked to a charity; skipped`);
      continue;
    }
    const rawLinkedIn = str(f.LinkedIn);
    const linkedin = normaliseLinkedIn(rawLinkedIn);
    if (rawLinkedIn && !linkedin) warn(`Ignored non-LinkedIn URL on founder ${name}: ${rawLinkedIn}`);
    const entry = { name, role: str(f.Role) || null, sortOrder: num(f['Sort order']), photo: firstAttachment(f.Photo), linkedin };
    for (const id of links) {
      if (!foundersByCharity.has(id)) foundersByCharity.set(id, []);
      foundersByCharity.get(id).push(entry);
    }
  }

  const charities = [];
  const slugs = new Set();
  const unknownTags = new Set();
  const unmapped = new Set();
  let skipped = 0;

  for (const rec of website) {
    const all = rec.fields || {};
    if (!isPublishable(all, cond)) {
      skipped += 1;
      continue;
    }
    const f = pick(all, allowlist.website); // from here on, only allowlisted fields exist
    const name = str(f['Display name']);
    if (!name) {
      warn(`Record ${rec.id} passes the publish rules but has no Display name; skipped`);
      continue;
    }

    const rawTags = arr(f['Cause tags']).map(str);
    const causes = causeTags.filter((t) => rawTags.includes(t));
    for (const t of rawTags) if (t && !causeTags.includes(t)) unknownTags.add(`"${t}" on ${name}`);

    const countries = arr(f.Countries).map(str).filter(Boolean);
    for (const c of countries) if (!continentOf[c]) unmapped.add(c);

    const rawUrl = str(f['Website URL']);
    const url = normaliseUrl(rawUrl);
    if (rawUrl && !url) warn(`Invalid Website URL on ${name}: ${rawUrl}`);

    const charityFounders = (foundersByCharity.get(rec.id) || [])
      .slice()
      .sort(bySortThenName)
      .map(({ name: founderName, role, photo, linkedin }) => ({ name: founderName, role, photo, linkedin }));

    if (!str(f.Blurb)) warn(`No blurb on ${name}`);
    if (!url) warn(`No website URL on ${name}`);
    if (!charityFounders.length) warn(`No founders linked to ${name}`);
    if (!causes.length) warn(`No agreed cause tag on ${name}`);
    if (!countries.length) warn(`No countries on ${name}`);

    charities.push({
      id: uniqueSlug(slugify(name), slugs),
      name,
      blurb: str(f.Blurb) || null,
      url,
      causes,
      countries,
      cohort: str(f['Cohort label']) || null,
      status: str(f.Status) || null,
      sortOrder: num(f['Sort order']),
      logo: firstAttachment(f.Logo),
      founders: charityFounders,
    });
  }

  charities.sort(byStatusSortThenName);
  for (const t of unknownTags) warn(`Ignored cause tag not in the agreed list: ${t}`);
  for (const c of unmapped) warn(`Country "${c}" has no continent in data/continents.json (will only show under All)`);

  const countryContinent = {};
  for (const c of charities) for (const k of c.countries) if (continentOf[k]) countryContinent[k] = continentOf[k];

  const data = {
    schemaVersion: 1,
    generatedAt: null, // set by the build
    causes: causeTags.slice(),
    continents: continents.continents.slice(),
    countryContinent: sortKeys(countryContinent),
    charities,
    stealth: { total: 0, byCause: {} }, // filled in by the build from countStealth()
  };

  const stats = {
    fetched: website.length,
    published: charities.length,
    skipped,
    founders: charities.reduce((n, c) => n + c.founders.length, 0),
    withLogo: charities.filter((c) => c.logo).length,
    withPhoto: charities.reduce((n, c) => n + c.founders.filter((x) => x.photo).length, 0),
    withLinkedIn: charities.reduce((n, c) => n + c.founders.filter((x) => x.linkedin).length, 0),
  };
  return { data, warnings, stats };
}

/** The complete set of keys that may appear in charities.json. Anything else fails the build. */
export const OUTPUT_KEYS = {
  root: ['schemaVersion', 'generatedAt', 'causes', 'continents', 'countryContinent', 'charities', 'stealth'],
  stealth: ['total', 'byCause'],
  charity: ['id', 'name', 'blurb', 'url', 'causes', 'countries', 'cohort', 'status', 'sortOrder', 'logo', 'founders'],
  founder: ['name', 'role', 'photo', 'linkedin'],
  image: ['src', 'width', 'height'],
};

/** Throw if the output contains unexpected keys, Airtable URLs or Airtable record ids. */
export function assertAllowlisted(data) {
  const problems = [];
  const checkKeys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(`unexpected key "${k}" in ${where}`);
  };
  checkKeys(data, OUTPUT_KEYS.root, 'root');
  if (data.stealth) {
    checkKeys(data.stealth, OUTPUT_KEYS.stealth, 'stealth');
    if (!Number.isInteger(data.stealth.total)) problems.push('stealth.total is not an integer');
    for (const [k, v] of Object.entries(data.stealth.byCause || {})) {
      if (!Number.isInteger(v)) problems.push(`stealth.byCause["${k}"] is not an integer`);
      if (!(data.causes || []).includes(k)) problems.push(`stealth.byCause has a key outside the agreed cause tags: "${k}"`);
    }
  }
  for (const c of data.charities || []) {
    checkKeys(c, OUTPUT_KEYS.charity, `charity ${c.id}`);
    if (c.logo) checkKeys(c.logo, OUTPUT_KEYS.image, `logo of ${c.id}`);
    for (const f of c.founders || []) {
      checkKeys(f, OUTPUT_KEYS.founder, `founder of ${c.id}`);
      if (f.photo) checkKeys(f.photo, OUTPUT_KEYS.image, `photo of ${f.name} (${c.id})`);
    }
  }
  const text = JSON.stringify(data);
  if (/airtableusercontent\.com|api\.airtable\.com|dl\.airtable\.com/i.test(text)) {
    problems.push('output contains an Airtable URL (expiring attachment link or API URL)');
  }
  // Airtable ids are 17 chars, e.g. recNM6wjmInmzKvdX; require a capital/digit so ordinary words don't match.
  if (/\b(rec|fld|tbl|app|sel|att)(?=[A-Za-z0-9]{14}\b)[a-z]*[A-Z0-9][A-Za-z0-9]*/.test(text)) {
    problems.push('output contains what looks like an Airtable id');
  }
  if (problems.length) throw new Error(`Allowlist check failed:\n - ${problems.join('\n - ')}`);
}

/**
 * Aggregate count of charities in stealth mode, per agreed cause tag. Re-checks the conditions in code
 * (status, checked/unchecked flags) so a wrong Airtable filter can't leak a count it shouldn't.
 * Returns numbers only; nothing about an individual record is retained.
 */
export function countStealth(records, { conditions, causeTags }) {
  const byCause = {};
  let total = 0;
  for (const r of records) {
    const f = r.fields || {};
    const statusField = conditions.statusField || 'Status';
    if (conditions.statusIn?.length && !conditions.statusIn.includes(f[statusField])) continue;
    if ((conditions.requireChecked || []).some((k) => f[k] !== true)) continue;
    if ((conditions.requireUnchecked || []).some((k) => f[k] === true)) continue;
    total += 1;
    const tags = Array.isArray(f[conditions.countField]) ? f[conditions.countField] : [];
    for (const t of causeTags) if (tags.includes(t)) byCause[t] = (byCause[t] || 0) + 1;
  }
  return { total, byCause: sortKeys(byCause) };
}
