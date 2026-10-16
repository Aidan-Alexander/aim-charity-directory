// Read-only Airtable REST client (listing records). Writes live in airtable-write.mjs and are used
// only by the MEL -> website sync, never by the build.
// Tokens come from environment variables and are never logged.

const API_ROOT = 'https://api.airtable.com/v0';

export function getToken(env = process.env) {
  return getTokenFromEnv('AIRTABLE_TOKEN', '  export AIRTABLE_TOKEN=...\n  npm run build', env);
}

/** Read a token from the named environment variable; the error message never contains the value. */
export function getTokenFromEnv(name, hint = `  export ${name}=...`, env = process.env) {
  const token = (env[name] || '').trim();
  if (!token) {
    throw new Error(`${name} is not set.\nExport it in your own shell (never commit it), then re-run:\n${hint}`);
  }
  return token;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the Airtable filterByFormula that mirrors the publish rules in config/publish.json.
 * Example output:
 *   AND({Website ready?},NOT({Undercover?}),NOT({Exclude from website}),OR({Status}="Active",{Status}="Shutdown",{Status}="Merged"))
 */
export function buildPublishFormula(conditions) {
  const parts = [];
  for (const field of conditions.requireChecked || []) parts.push(`{${field}}`);
  for (const field of conditions.requireUnchecked || []) parts.push(`NOT({${field}})`);
  if (conditions.statusIn?.length) {
    const statusField = conditions.statusField || 'Status';
    parts.push(`OR(${conditions.statusIn.map((s) => `{${statusField}}="${s}"`).join(',')})`);
  }
  if (conditions.publishFormulaField) parts.push(`{${conditions.publishFormulaField}}="Yes"`);
  return `AND(${parts.join(',')})`;
}

/**
 * List every record in a table, following pagination.
 * `fields` limits which fields Airtable returns (so unpublished fields are never downloaded); names or field ids.
 * `returnFieldsByFieldId` keys each record's `fields` by field id instead of name (the sync uses this).
 */
export async function listAllRecords({
  token,
  baseId,
  tableId,
  fields = [],
  filterByFormula,
  returnFieldsByFieldId = false,
  pageSize = 100,
  fetchImpl = fetch,
  log = () => {},
}) {
  const records = [];
  let offset;
  let page = 0;
  do {
    const params = new URLSearchParams();
    params.set('pageSize', String(pageSize));
    for (const f of [...new Set(fields)]) params.append('fields[]', f);
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    if (returnFieldsByFieldId) params.set('returnFieldsByFieldId', 'true');
    if (offset) params.set('offset', offset);

    const url = `${API_ROOT}/${baseId}/${tableId}?${params.toString()}`;
    const body = await requestJson(url, token, fetchImpl);
    const batch = Array.isArray(body.records) ? body.records : [];
    records.push(...batch);
    offset = body.offset;
    page += 1;
    log(`  ${tableId}: page ${page}, ${batch.length} records${offset ? ' (more to fetch)' : ''}`);
    if (offset) await sleep(220); // Airtable allows 5 requests/second per base
  } while (offset);
  return records;
}

/**
 * One JSON request against the Airtable API. GET by default; pass { method, body } for writes.
 * Retries a 429 after the 30 second back-off Airtable asks for, and a 5xx a couple of times.
 * Neither the thrown message nor the logged URL ever contains the token.
 */
export async function requestJson(url, token, fetchImpl = fetch, { method = 'GET', body } = {}, attempt = 1) {
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  if (res.status === 429 && attempt <= 3) {
    await sleep(30_000);
    return requestJson(url, token, fetchImpl, { method, body }, attempt + 1);
  }
  if (res.status >= 500 && attempt <= 3) {
    await sleep(2_000 * attempt);
    return requestJson(url, token, fetchImpl, { method, body }, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Neither the URL path nor the body contains the token.
    throw new Error(`Airtable responded ${res.status} ${res.statusText} for ${method} ${url.replace(/\?.*$/, '')}\n${text.slice(0, 600)}`);
  }
  return res.json();
}

export { API_ROOT, sleep };
