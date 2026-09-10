// Read-only Airtable REST client.
// The token comes from the AIRTABLE_TOKEN environment variable and is never logged.

const API_ROOT = 'https://api.airtable.com/v0';

export function getToken(env = process.env) {
  const token = (env.AIRTABLE_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'AIRTABLE_TOKEN is not set.\n' +
        'Export it in your own shell (never commit it), then re-run:\n' +
        '  export AIRTABLE_TOKEN=...\n' +
        '  npm run build'
    );
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
 * `fields` limits which fields Airtable returns (so unpublished fields are never downloaded).
 */
export async function listAllRecords({
  token,
  baseId,
  tableId,
  fields = [],
  filterByFormula,
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

async function requestJson(url, token, fetchImpl, attempt = 1) {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429 && attempt <= 3) {
    await sleep(30_000); // Airtable asks for a 30 second back-off after a 429
    return requestJson(url, token, fetchImpl, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Neither the URL path nor the body contains the token.
    throw new Error(`Airtable responded ${res.status} ${res.statusText} for ${url.replace(/\?.*$/, '')}\n${text.slice(0, 600)}`);
  }
  return res.json();
}
