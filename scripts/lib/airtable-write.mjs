// Airtable schema reads and record writes. Used ONLY by scripts/sync-from-mel.mjs, and only against the
// website base: any base registered with forbidWrites() (the sync registers the MEL base before it does
// anything else) is rejected here, in code, whatever token the process was given.

import { API_ROOT, requestJson, sleep } from './airtable.mjs';

const READ_ONLY_BASES = new Set();

/** Mark a base as read-only for this process. Any write aimed at it throws before a request is made. */
export function forbidWrites(baseId) {
  READ_ONLY_BASES.add(baseId);
}

function assertWritable(baseId) {
  if (READ_ONLY_BASES.has(baseId)) {
    throw new Error(`Refusing to write to base ${baseId}: it is registered as read-only (MEL is never written by this pipeline).`);
  }
}

/**
 * Base schema from the metadata API (needs the PAT scope schema.bases:read on that base).
 * Returns Airtable's shape: { tables: [{ id, name, primaryFieldId, fields: [{ id, name, type, options }] }] }.
 */
export async function getBaseSchema({ token, baseId, fetchImpl = fetch }) {
  return requestJson(`${API_ROOT}/meta/bases/${baseId}/tables`, token, fetchImpl);
}

/** Find a field by exact name in a table of a schema; null when absent. */
export function findFieldByName(schema, tableId, name) {
  const table = (schema.tables || []).find((t) => t.id === tableId || t.name === tableId);
  if (!table) throw new Error(`Table ${tableId} is not in the base schema`);
  return (table.fields || []).find((f) => f.name === name) || null;
}

/** Field by id in a table of a schema; null when absent. */
export function findFieldById(schema, tableId, fieldId) {
  const table = (schema.tables || []).find((t) => t.id === tableId || t.name === tableId);
  if (!table) throw new Error(`Table ${tableId} is not in the base schema`);
  return (table.fields || []).find((f) => f.id === fieldId) || null;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * PATCH records in batches of 10 (Airtable's maximum). PATCH, not PUT: fields not mentioned are left alone.
 * `records` = [{ id, fields: { <field id or name>: value } }]. typecast lets new select options be created.
 */
export async function patchRecords({ token, baseId, tableId, records, typecast = true, fetchImpl = fetch, log = () => {} }) {
  assertWritable(baseId);
  const updated = [];
  const batches = chunks(records, 10);
  for (let i = 0; i < batches.length; i += 1) {
    const body = await requestJson(`${API_ROOT}/${baseId}/${tableId}`, token, fetchImpl, {
      method: 'PATCH',
      body: { records: batches[i], typecast },
    });
    updated.push(...(body.records || []));
    log(`  PATCH ${tableId}: batch ${i + 1}/${batches.length}, ${batches[i].length} record(s)`);
    if (i + 1 < batches.length) await sleep(220);
  }
  return updated;
}

/** POST new records in batches of 10. `records` = [{ fields: {...} }]. */
export async function createRecords({ token, baseId, tableId, records, typecast = true, fetchImpl = fetch, log = () => {} }) {
  assertWritable(baseId);
  const created = [];
  const batches = chunks(records, 10);
  for (let i = 0; i < batches.length; i += 1) {
    const body = await requestJson(`${API_ROOT}/${baseId}/${tableId}`, token, fetchImpl, {
      method: 'POST',
      body: { records: batches[i], typecast },
    });
    created.push(...(body.records || []));
    log(`  POST ${tableId}: batch ${i + 1}/${batches.length}, ${batches[i].length} record(s)`);
    if (i + 1 < batches.length) await sleep(220);
  }
  return created;
}
