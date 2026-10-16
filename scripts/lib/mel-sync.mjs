// Pure logic for the MEL -> website sync: compute what each website row should hold, diff it against what
// it holds, and describe the result. No network access here. Records are in the Airtable REST shape with
// `fields` keyed by FIELD ID ({ id, fields: { fldXXX: value } }), as returned with returnFieldsByFieldId=true.

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);
/** Linked-record values: the REST API returns record ids; fixtures may hold { id, name } objects. */
const linkIds = (v) => arr(v).map((l) => (typeof l === 'string' ? l : l && l.id)).filter(Boolean);
/** Multiple-select values: names (REST) or { name } objects. */
const nameList = (v) => arr(v).map((x) => (typeof x === 'string' ? x : x && x.name)).map(str).filter(Boolean);
const selectName = (v) => (v && typeof v === 'object' ? str(v.name) : str(v));

/* ------------------------------------------------------------------------------------------------ places */

/** Places table -> Map(record id -> { id, name, type, partOf: [other place ids] }). Self-links are dropped. */
export function indexPlaces(records, f) {
  const map = new Map();
  for (const r of records) {
    const fields = r.fields || {};
    map.set(r.id, {
      id: r.id,
      name: str(fields[f.name]),
      type: selectName(fields[f.type]),
      partOf: linkIds(fields[f.partOf]).filter((id) => id !== r.id),
    });
  }
  return map;
}

/** Cohort table -> Map(record id -> name). */
export function indexCohorts(records, f) {
  return new Map(records.map((r) => [r.id, str((r.fields || {})[f.name])]));
}

/** Stable order for a Countries value: kept regions first (in config order), then A-Z; duplicates removed. */
export function normaliseCountries(list, regionsKept = []) {
  const unique = [...new Set(list.map(str).filter(Boolean))];
  const rank = (n) => {
    const i = regionsKept.indexOf(n);
    return i === -1 ? regionsKept.length : i;
  };
  return unique.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en'));
}

/** Order-insensitive equality of two Countries values. */
export function sameCountries(a, b) {
  const x = normaliseCountries(a);
  const y = normaliseCountries(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * MEL "Places of operation" (place record ids) -> website Countries option names.
 *   country              -> itself (through countryNameMap)
 *   subnational entity   -> its parent country (the "Is part of" link whose type is country)
 *   kept region          -> the website option of the same name ("Global", "Europe"), matched by NAME whatever its Type
 *   anything else        -> dropped (other regions, income groups)
 */
export function countriesFromPlaces(placeIds, places, { placeTypes, regionsKept, nameMap }) {
  const mapName = (n) => (Object.prototype.hasOwnProperty.call(nameMap, n) ? nameMap[n] : n);
  const out = [];
  const dropped = [];
  const unknown = [];
  const notes = [];
  for (const id of placeIds) {
    const p = places.get(id);
    if (!p) {
      unknown.push(id);
      continue;
    }
    if (p.type === placeTypes.country) out.push(mapName(p.name));
    else if (p.type === placeTypes.subnational) {
      const parents = p.partOf.map((x) => places.get(x)).filter((x) => x && x.type === placeTypes.country);
      if (!parents.length) notes.push(`"${p.name}" is a subnational entity with no parent country in MEL Places; ignored`);
      for (const c of parents) out.push(mapName(c.name));
    } else if (regionsKept.includes(p.name)) out.push(p.name);
    else dropped.push(p.name);
  }
  return { countries: normaliseCountries(out, regionsKept), dropped, unknown, notes };
}

/** MEL cohort link -> website Cohort label ("2025 H1 " -> "2025 H1", "2024 EGI" -> "2024 Effective Giving"). */
export function cohortLabelFrom(cohortIds, cohorts, rules = {}) {
  const names = cohortIds.map((id) => cohorts.get(id)).filter(Boolean);
  if (!names.length) return { value: '', notes: [] };
  let label = str(names[0]);
  for (const [from, to] of Object.entries(rules.replace || {})) label = label.split(from).join(to);
  const notes = names.length > 1 ? [`linked to ${names.length} cohorts in MEL; using "${names[0].trim()}"`] : [];
  return { value: label.trim(), notes };
}

/* --------------------------------------------------------------------------------------- field registry */

/** Text stored in a "(from MEL)" state field when MEL's derived value is empty. An empty field means "no baseline yet". */
export const STATE_NONE = '(none)';

/**
 * Everything the sync knows how to compute from MEL. Only the keys listed in config.sync.fields are written to
 * existing rows; the rest are reported as "not synced" differences so turning them on later is a config change.
 *   compute(rec, ctx) -> { value, skipReason?, notes[] }   current(row, F) reads the website row   equal(a, b)
 *   toState(value, ctx) / fromState(text): the value as remembered in the row's "(from MEL)" state field, and back
 *   (fromState returns null for an empty field: no baseline yet).
 */
export const SYNCABLE_FIELDS = {
  countries: {
    label: 'Countries',
    websiteField: 'countries',
    empty: [],
    compute: (rec, ctx) => {
      const M = ctx.melFields;
      const placeIds = linkIds(rec.fields[M.places]);
      if (!placeIds.length) return { value: [], skipReason: 'MEL Places of operation is blank (blank never clears the website)', notes: [] };
      const r = countriesFromPlaces(placeIds, ctx.places, ctx.placeRules);
      const notes = [...r.notes];
      if (r.dropped.length) notes.push(`dropped (region/income group): ${r.dropped.join(', ')}`);
      if (r.unknown.length) notes.push(`unknown place ids: ${r.unknown.join(', ')}`);
      if (!r.countries.length) return { value: [], skipReason: 'MEL lists only regions or income groups; no country to write', notes };
      return { value: r.countries, notes };
    },
    current: (row, F) => nameList(row.fields[F.countries]),
    equal: sameCountries,
    format: (v) => (arr(v).length ? normaliseCountries(v).join(', ') : '(blank)'),
    toState: (v, ctx) => (arr(v).length ? normaliseCountries(v, ctx.placeRules.regionsKept).join(', ') : STATE_NONE),
    fromState: (text) => {
      const t = str(text);
      if (!t) return null;
      if (t === STATE_NONE) return [];
      return t.split(',').map(str).filter(Boolean);
    },
  },
  status: {
    label: 'Status',
    websiteField: 'status',
    empty: '',
    compute: (rec, ctx) => ({ value: selectName(rec.fields[ctx.melFields.status]), notes: [] }),
    current: (row, F) => selectName(row.fields[F.status]),
    equal: (a, b) => str(a) === str(b),
    format: (v) => str(v) || '(blank)',
    toState: (v) => str(v) || STATE_NONE,
    fromState: (text) => (str(text) ? (str(text) === STATE_NONE ? '' : str(text)) : null),
  },
  cohortLabel: {
    label: 'Cohort label',
    websiteField: 'cohortLabel',
    empty: '',
    compute: (rec, ctx) => cohortLabelFrom(linkIds(rec.fields[ctx.melFields.cohort]), ctx.cohorts, ctx.cohortRules),
    current: (row, F) => str(row.fields[F.cohortLabel]),
    equal: (a, b) => str(a) === str(b),
    format: (v) => str(v) || '(blank)',
    toState: (v) => str(v) || STATE_NONE,
    fromState: (text) => (str(text) ? (str(text) === STATE_NONE ? '' : str(text)) : null),
  },
  undercover: {
    label: 'Undercover?',
    websiteField: 'undercover',
    empty: false,
    // MEL's Undercover? is free text ("Yes", "Private research report", ...): anything non-blank counts.
    compute: (rec, ctx) => ({ value: str(rec.fields[ctx.melFields.undercover]) !== '', notes: [] }),
    current: (row, F) => row.fields[F.undercover] === true,
    equal: (a, b) => Boolean(a) === Boolean(b),
    format: (v) => (v ? 'ticked' : 'unticked'),
    toState: (v) => (v ? 'ticked' : 'unticked'),
    fromState: (text) => (str(text) ? str(text) === 'ticked' : null),
  },
};

/* --------------------------------------------------------------------------------------- named fields */

function resolveNamedFields(schema, config, byName, knownIds, allowedTypes, kind) {
  const { table: t } = config.website;
  const table = (schema.tables || []).find((x) => x.id === t.id || x.name === t.name);
  if (!table) throw new Error(`Table ${t.id} (${t.name}) is not in the website base schema`);
  const fields = table.fields || [];
  const ids = {};
  const missing = [];
  const warnings = [];
  for (const [key, name] of Object.entries(byName)) {
    if (key.startsWith('$')) continue;
    const named = fields.find((f) => f.name === name);
    if (named && allowedTypes.includes(named.type)) {
      ids[key] = named.id;
      if (knownIds[key] && knownIds[key] !== named.id) warnings.push(`"${name}" is ${named.id} in the base but ${knownIds[key]} in config/sync.json; using the base`);
      continue;
    }
    if (named) {
      missing.push(`${name} (exists but is a ${named.type}, not ${kind})`);
      continue;
    }
    const known = knownIds[key] ? fields.find((f) => f.id === knownIds[key]) : null;
    if (known && allowedTypes.includes(known.type)) {
      ids[key] = known.id;
      warnings.push(`no field named "${name}"; using ${known.id} (now called "${known.name}") from config/sync.json. Rename it back or update the config`);
      continue;
    }
    missing.push(name);
  }
  return { ids, missing, warnings };
}

/**
 * Resolve the per-field override checkboxes ("Countries: manual") from the website base schema (metadata API shape).
 * By NAME first, which is the rule; a known id from config/sync.json is used only when no field of that name exists
 * (the checkbox was renamed), with a warning. A field of the right name but the wrong type counts as missing.
 * @returns {{ ids: Record<string,string>, missing: string[], warnings: string[] }}
 */
export function resolveOverrideFields(schema, config) {
  return resolveNamedFields(schema, config, config.website.overrideFieldsByName || {}, config.website.overrideFieldIds || {}, ['checkbox'], 'a checkbox');
}

/** Same for the "(from MEL)" state fields, which are long-text fields the sync owns. */
export function resolveStateFields(schema, config) {
  return resolveNamedFields(schema, config, config.website.stateFieldsByName || {}, config.website.stateFieldIds || {}, ['multilineText', 'singleLineText', 'richText'], 'a long text field');
}

/* ------------------------------------------------------------------------------------------------- plan */

/** A website row is already public when it passes the same rules the build applies. */
export function isPublicRow(row, F, statusIn) {
  const f = row.fields || {};
  return f[F.websiteReady] === true && f[F.undercover] !== true && f[F.excludeFromWebsite] !== true && statusIn.includes(selectName(f[F.status]));
}

const normName = (s) =>
  str(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const listMinus = (a, b) => {
  if (!Array.isArray(a)) return [];
  const other = new Set(Array.isArray(b) ? b : []);
  return a.filter((x) => !other.has(x));
};

/**
 * Compute the full plan. Nothing here touches the network.
 * @param {{ mel: object[], website: object[], places: Map, cohorts: Map, countryOptions?: string[] }} data
 * @param {{ config: object, overrideFieldIds?: object, stateFieldIds?: object, statusIn?: string[], continents?: object }} deps
 *   overrideFieldIds: { countries: 'fld...' } per synced field whose override checkbox exists (missing = no override possible)
 *   stateFieldIds:    { countries: 'fld...' } per field that has a "(from MEL)" state field (missing = no drift flags)
 *   statusIn: statuses the build publishes (from config/publish.json), used only to decide which names a public log may show
 */
export function planSync(
  { mel, website, places, cohorts, countryOptions = null },
  { config, overrideFieldIds = {}, stateFieldIds = {}, statusIn = ['Active', 'Shutdown', 'Merged'], continents = null }
) {
  const F = config.website.fields;
  const M = config.mel.tables.charities.fields;
  const activeKeys = config.sync.fields || [];
  for (const k of activeKeys) if (!SYNCABLE_FIELDS[k]) throw new Error(`config/sync.json sync.fields lists unknown field "${k}"`);
  const ctx = {
    melFields: M,
    places,
    cohorts,
    placeRules: { placeTypes: config.mel.placeTypes, regionsKept: config.mel.regionsKeptAsOptions || [], nameMap: config.countryNameMap || {} },
    cohortRules: config.cohortLabel || {},
  };

  const plan = {
    updates: [], // content: [{ websiteId, melId, name, hidden, fields: [{ key, label, fieldId, before, after, beforeText, afterText, notes }] }]
    creates: [], // [{ melId, name, hidden: true, fields: { fieldId: value }, summary: { label: text }, notes }]
    stateUpdates: [], // bookkeeping: [{ websiteId, melId, name, hidden, key, label, fieldId, before, after }]
    drift: [], // manual-override rows whose MEL value changed since last run: [{ websiteId, melId, name, hidden, key, label, added, removed, melText, websiteText, overrideName }]
    skipped: [], // [{ websiteId, melId, name, hidden, key, label, reason, notes }]
    notSynced: [], // informational: differences in fields not listed under sync.fields
    unlinked: [], // website rows without a MEL Charity ID, with name-based suggestions
    warnings: [], // [{ code, text, name?, hidden?, id? }]  (text never contains a name; use label())
    newOptions: [], // target country names that are not yet an option of the website Countries field
    missingContinents: [], // target country names missing from data/continents.json
    overrideFieldNames: config.website.overrideFieldsByName || {},
    stateFieldNames: config.website.stateFieldsByName || {},
    stats: { melRecords: mel.length, websiteRows: website.length, unchanged: 0, checked: 0 },
  };
  const warn = (code, text, extra = {}) => plan.warnings.push({ code, text, ...extra });

  // Website rows by MEL Charity ID. Duplicated keys are never written.
  const byMel = new Map();
  const dupes = new Map();
  for (const row of website) {
    const key = str(row.fields[F.melCharityId]);
    const name = str(row.fields[F.displayName]) || '(no display name)';
    const hidden = !isPublicRow(row, F, statusIn);
    if (!key) {
      plan.unlinked.push({ websiteId: row.id, name, hidden, suggestions: [] });
      continue;
    }
    if (byMel.has(key) || dupes.has(key)) {
      if (!dupes.has(key)) dupes.set(key, [byMel.get(key)]);
      dupes.get(key).push({ row, name, hidden });
      byMel.delete(key);
      continue;
    }
    byMel.set(key, { row, name, hidden });
  }
  for (const [key, rows] of dupes) {
    warn('duplicate-key', `${rows.length} website rows share MEL Charity ID ${key}; none of them is written until that is fixed`, { id: key, hidden: rows.some((r) => r.hidden) });
  }
  const melById = new Map(mel.map((r) => [r.id, r]));
  for (const [key, { name, hidden }] of byMel) {
    if (!melById.has(key)) warn('stale-key', `website row points at MEL record ${key}, which is not in MEL Charities`, { name, hidden, id: key });
  }

  const optionSet = countryOptions ? new Set(countryOptions) : null;
  const continentOf = continents ? continents.countries || {} : null;
  const noteOptions = (names) => {
    for (const n of names) {
      if (optionSet && !optionSet.has(n) && !plan.newOptions.includes(n)) plan.newOptions.push(n);
      if (continentOf && !continentOf[n] && !plan.missingContinents.includes(n)) plan.missingContinents.push(n);
    }
  };

  for (const rec of mel) {
    const melName = str(rec.fields[M.name]) || '(unnamed MEL record)';
    const targets = Object.fromEntries(Object.entries(SYNCABLE_FIELDS).map(([k, def]) => [k, def.compute(rec, ctx)]));
    const hit = byMel.get(rec.id);

    const dup = dupes.get(rec.id);
    if (dup) {
      // The key is on more than one website row: neither row is written and no row is created until that is fixed.
      for (const d of dup) plan.skipped.push({ websiteId: d.row.id, melId: rec.id, name: d.name, hidden: d.hidden, key: null, label: 'All fields', reason: 'MEL Charity ID appears on more than one website row', notes: [] });
      continue;
    }

    if (!hit) {
      if (!config.sync.createMissingRows) continue;
      const fields = {};
      fields[F.displayName] = melName;
      fields[F.melCharityId] = rec.id;
      if (targets.cohortLabel.value) fields[F.cohortLabel] = targets.cohortLabel.value;
      if (targets.status.value) fields[F.status] = targets.status.value;
      if (targets.countries.value.length) fields[F.countries] = targets.countries.value;
      if (targets.undercover.value) fields[F.undercover] = true;
      // Website ready? is deliberately left unticked: a new row is never published until someone finishes it.
      for (const [key, stateId] of Object.entries(stateFieldIds)) if (SYNCABLE_FIELDS[key]) fields[stateId] = SYNCABLE_FIELDS[key].toState(targets[key].value, ctx);
      noteOptions(targets.countries.value);
      plan.creates.push({
        melId: rec.id,
        name: melName,
        hidden: true, // not on the website yet, so never named in a public log
        fields,
        summary: {
          'Cohort label': SYNCABLE_FIELDS.cohortLabel.format(targets.cohortLabel.value),
          Status: SYNCABLE_FIELDS.status.format(targets.status.value),
          Countries: SYNCABLE_FIELDS.countries.format(targets.countries.value),
          'Undercover?': SYNCABLE_FIELDS.undercover.format(targets.undercover.value),
        },
        notes: [...targets.countries.notes, ...targets.cohortLabel.notes],
      });
      continue;
    }

    const { row, name, hidden } = hit;
    const update = { websiteId: row.id, melId: rec.id, name, hidden, fields: [] };
    for (const [key, def] of Object.entries(SYNCABLE_FIELDS)) {
      const target = targets[key];
      const before = def.current(row, F);
      const active = activeKeys.includes(key);
      const overrideId = overrideFieldIds[key];
      const manual = Boolean(overrideId && row.fields[overrideId] === true);

      // State store and drift flags. The MEL-derived value is remembered on the row every run (bookkeeping, not a
      // content change). A manual-override row whose remembered value differs from today's is flagged once, when
      // MEL changes, instead of every night for as long as the row differs from MEL.
      const stateId = stateFieldIds[key];
      if (stateId) {
        const derived = target.skipReason ? def.empty : target.value;
        const newText = def.toState(derived, ctx);
        const storedText = str(row.fields[stateId]);
        if (storedText !== newText) plan.stateUpdates.push({ websiteId: row.id, melId: rec.id, name, hidden, key, label: def.label, fieldId: stateId, before: storedText, after: newText });
        const stored = def.fromState(storedText);
        if (active && manual && stored !== null && !def.equal(stored, derived)) {
          plan.drift.push({
            websiteId: row.id,
            melId: rec.id,
            name,
            hidden,
            key,
            label: def.label,
            added: listMinus(derived, stored),
            removed: listMinus(stored, derived),
            melText: def.format(derived),
            websiteText: def.format(before),
            overrideName: plan.overrideFieldNames[key] || 'the override checkbox',
          });
        }
      }

      if (!active) {
        if (!target.skipReason && !def.equal(before, target.value)) {
          plan.notSynced.push({ key, label: def.label, websiteId: row.id, melId: rec.id, name, hidden, before: def.format(before), after: def.format(target.value) });
        }
        continue;
      }
      plan.stats.checked += 1;
      if (target.skipReason) {
        plan.skipped.push({ websiteId: row.id, melId: rec.id, name, hidden, key, label: def.label, reason: target.skipReason, notes: target.notes });
        continue;
      }
      if (manual) {
        plan.skipped.push({ websiteId: row.id, melId: rec.id, name, hidden, key, label: def.label, reason: `"${plan.overrideFieldNames[key]}" is ticked (curated by hand)`, notes: [] });
        continue;
      }
      if (def.equal(before, target.value)) {
        plan.stats.unchanged += 1;
        continue;
      }
      if (key === 'countries') noteOptions(target.value);
      update.fields.push({ key, label: def.label, fieldId: F[def.websiteField], before, after: target.value, beforeText: def.format(before), afterText: def.format(target.value), notes: target.notes });
    }
    if (update.fields.length) plan.updates.push(update);
  }

  // Suggestions for website rows that have no MEL Charity ID yet: exact (normalised) name matches on MEL Name / Previous names.
  if (plan.unlinked.length) {
    const linkedMel = new Set(byMel.keys());
    const candidates = [];
    for (const rec of mel) {
      if (linkedMel.has(rec.id)) continue;
      const names = [str(rec.fields[M.name]), ...str(rec.fields[M.previousNames]).split(',')].map(normName).filter(Boolean);
      candidates.push({ melId: rec.id, melName: str(rec.fields[M.name]), names });
    }
    for (const u of plan.unlinked) {
      const n = normName(u.name);
      if (!n) continue;
      u.suggestions = candidates.filter((c) => c.names.includes(n)).map(({ melId, melName }) => ({ melId, melName }));
    }
  }

  plan.newOptions.sort((a, b) => a.localeCompare(b, 'en'));
  plan.missingContinents.sort((a, b) => a.localeCompare(b, 'en'));
  return plan;
}

/** True when the run has something worth telling people about: a content write, a new row, or a drift flag. */
export function hasChanges(plan) {
  return plan.updates.length > 0 || plan.creates.length > 0 || plan.drift.length > 0;
}

/* ------------------------------------------------------------------------------------------- formatting */

/**
 * How a row is named in output. With redact=true (public Action logs), only rows that are already public on
 * the website are named; everything else shows as "[hidden]" plus its record id, which identifies nothing
 * without access to the base. Record ids are kept so a row can still be found from the log.
 */
export function label(item, redact) {
  const id = item.websiteId || item.melId || item.id || '';
  if (redact && item.hidden) return `[hidden] ${id}`.trim();
  return id ? `${item.name} (${id})` : item.name;
}

function hiddenValue(text, item, redact) {
  return redact && item.hidden ? '(values hidden)' : text;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Human-readable plan for the console / Action log. */
export function formatPlan(plan, { mode = 'dry-run', redact = false } = {}) {
  const L = [];
  const n = plan.updates.length;
  const verb = mode === 'apply' ? 'will change' : 'would change';
  L.push(`${plural(n, 'website row')} ${verb}:`);
  for (const u of plan.updates) {
    L.push(`  ${label(u, redact)}`);
    for (const f of u.fields) {
      L.push(`    ${f.label}:`);
      L.push(`      - ${hiddenValue(f.beforeText, u, redact)}`);
      L.push(`      + ${hiddenValue(f.afterText, u, redact)}`);
      for (const note of f.notes) L.push(`      note: ${hiddenValue(note, u, redact)}`);
    }
  }
  if (!n) L.push('  (none)');

  L.push('');
  const c = plan.creates.length;
  L.push(`${plural(c, 'website row')} ${mode === 'apply' ? 'will be' : 'would be'} created (Website ready? unticked):`);
  for (const cr of plan.creates) {
    L.push(`  ${label(cr, redact)}`);
    if (!(redact && cr.hidden)) {
      for (const [k, v] of Object.entries(cr.summary)) L.push(`    ${k}: ${v}`);
      for (const note of cr.notes || []) L.push(`    note: ${note}`);
    }
  }
  if (!c) L.push('  (none)');

  if (plan.drift.length) {
    L.push('');
    L.push(`${plural(plan.drift.length, 'manual-override row')} where MEL changed since the last run (nothing written; untick the override checkbox to let the sync apply MEL's value):`);
    for (const d of plan.drift) {
      L.push(`  ${label(d, redact)}  [${d.label}]`);
      if (redact && d.hidden) {
        L.push('    (values hidden)');
        continue;
      }
      if (d.added.length) L.push(`    added in MEL:   ${d.added.join(', ')}`);
      if (d.removed.length) L.push(`    removed in MEL: ${d.removed.join(', ')}`);
      L.push(`    MEL now:        ${d.melText}`);
      L.push(`    website keeps:  ${d.websiteText}`);
    }
  }

  if (plan.stateUpdates.length) {
    L.push('');
    const names = [...new Set(plan.stateUpdates.map((s) => plan.stateFieldNames[s.key] || s.key))];
    L.push(`${plural(plan.stateUpdates.length, 'row')} ${mode === 'apply' ? 'get' : 'would get'} the "${names.join('", "')}" field refreshed with MEL's current value (bookkeeping, not a content change)`);
  }

  L.push('');
  const byReason = new Map();
  for (const s of plan.skipped) {
    const k = `${s.label}: ${s.reason}`;
    if (!byReason.has(k)) byReason.set(k, []);
    byReason.get(k).push(s);
  }
  L.push(`Skipped ${plan.skipped.length}, unchanged ${plan.stats.unchanged} (of ${plan.stats.checked} field checks on linked rows):`);
  for (const [reason, items] of byReason) {
    L.push(`  ${items.length} x ${reason}`);
    L.push(`    ${items.map((s) => label(s, redact)).join('; ')}`);
  }

  if (plan.unlinked.length) {
    L.push('');
    L.push(`${plural(plan.unlinked.length, 'website row')} without a MEL Charity ID (never written; fill in the key to link):`);
    for (const u of plan.unlinked) {
      const sug = u.suggestions.length ? ` -> possible MEL match: ${u.suggestions.map((s) => (redact ? s.melId : `${s.melName} (${s.melId})`)).join(', ')}` : '';
      L.push(`  ${label(u, redact)}${sug}`);
    }
  }

  if (plan.newOptions.length) {
    L.push('');
    L.push(`New Countries options the write will create (typecast): ${plan.newOptions.join(', ')}`);
  }
  if (plan.missingContinents.length) {
    L.push(`Not in data/continents.json yet (will only show under "All" on the site until added): ${plan.missingContinents.join(', ')}`);
  }

  if (plan.notSynced.length) {
    L.push('');
    L.push(`Differences in fields that are NOT synced yet (information only; enable in config/sync.json -> sync.fields):`);
    for (const d of plan.notSynced) {
      L.push(`  ${d.label}: ${label(d, redact)}: website "${hiddenValue(d.before, d, redact)}" vs MEL "${hiddenValue(d.after, d, redact)}"`);
    }
  }

  if (plan.warnings.length) {
    L.push('');
    L.push(`${plural(plan.warnings.length, 'warning')}:`);
    for (const w of plan.warnings) L.push(`  - ${w.name ? `${label(w, redact)}: ` : ''}${w.text}`);
  }
  return L;
}

/** Short Slack message. Full names: this goes to an internal channel, not a public log. */
export function formatDigest(plan, { mode = 'dry-run', when = new Date(), maxLines = 25 } = {}) {
  const date = when.toISOString().slice(0, 10);
  const head = mode === 'apply' ? `MEL -> website sync ${date}: applied` : `MEL -> website sync ${date}: pending (dry run, nothing written)`;
  const lines = [];
  for (const u of plan.updates) for (const f of u.fields) lines.push(`• ${u.name}: ${f.label} ${f.beforeText} -> ${f.afterText}`);
  for (const c of plan.creates) lines.push(`• new row: ${c.name} (${c.summary.Status}, ${c.summary['Cohort label']}, ${c.summary.Countries})`);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`… and ${lines.length - maxLines} more`);
  const counts = `${plan.updates.length} updated, ${plan.creates.length} created, ${plan.drift.length} flagged, ${plan.skipped.length} skipped, ${plural(plan.warnings.length, 'warning')}`;
  let drift = '';
  if (plan.drift.length) {
    const items = plan.drift.map((d) => {
      const parts = [];
      if (d.added.length) parts.push(`added in MEL: ${d.added.join(', ')}`);
      if (d.removed.length) parts.push(`removed in MEL: ${d.removed.join(', ')}`);
      return `• ${d.name}: ${parts.join('; ') || `${d.label} changed in MEL`}. MEL now: ${d.melText}; website keeps: ${d.websiteText}. Untick "${d.overrideName}" to let the sync apply MEL's list.`;
    });
    drift = `\nManual-override rows where MEL changed (${plan.drift[0].label} not written):\n${items.join('\n')}`;
  }
  const tail = plan.warnings.length ? `\nWarnings: ${plan.warnings.map((w) => (w.name ? `${w.name}: ` : '') + w.text).join(' | ')}` : '';
  return `${head} (${counts})\n${shown.join('\n')}${drift}${tail}`.trim();
}

/** Markdown for the GitHub Actions step summary (public on a public repo, hence redacted like the log). */
export function formatStepSummary(plan, { mode = 'dry-run', redact = true } = {}) {
  const L = [];
  L.push(`## MEL -> website sync (${mode === 'apply' ? 'applied' : 'dry run, nothing written'})`);
  L.push('');
  L.push(`| | count |\n|---|---|\n| rows updated | ${plan.updates.length} |\n| rows created | ${plan.creates.length} |\n| manual rows flagged (MEL changed) | ${plan.drift.length} |\n| skipped | ${plan.skipped.length} |\n| unchanged | ${plan.stats.unchanged} |\n| warnings | ${plan.warnings.length} |`);
  if (plan.updates.length) {
    L.push('');
    L.push('| row | field | before | after |\n|---|---|---|---|');
    for (const u of plan.updates) for (const f of u.fields) L.push(`| ${label(u, redact)} | ${f.label} | ${hiddenValue(f.beforeText, u, redact)} | ${hiddenValue(f.afterText, u, redact)} |`);
  }
  if (plan.creates.length) {
    L.push('');
    L.push(`Created: ${plan.creates.map((c) => label(c, redact)).join(', ')}`);
  }
  if (plan.drift.length) {
    L.push('');
    L.push('Manual-override rows where MEL changed (nothing written):');
    L.push('');
    L.push('| row | field | added in MEL | removed in MEL | MEL now | website keeps |\n|---|---|---|---|---|---|');
    for (const d of plan.drift) {
      const h = (t) => hiddenValue(t, d, redact);
      L.push(`| ${label(d, redact)} | ${d.label} | ${h(d.added.join(', ') || '-')} | ${h(d.removed.join(', ') || '-')} | ${h(d.melText)} | ${h(d.websiteText)} |`);
    }
  }
  if (plan.warnings.length) {
    L.push('');
    for (const w of plan.warnings) L.push(`- ${w.name ? `${label(w, redact)}: ` : ''}${w.text}`);
  }
  return `${L.join('\n')}\n`;
}
