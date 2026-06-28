const SUPABASE_REST_PATH = '/rest/v1';

function databaseEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function databaseUrl(table, params = new URLSearchParams()) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const query = params.toString();
  return `${base}${SUPABASE_REST_PATH}/${table}${query ? `?${query}` : ''}`;
}

async function databaseRequest(table, { method = 'GET', params = new URLSearchParams(), body, headers = {} } = {}) {
  if (!databaseEnabled()) {
    const error = new Error('Supabase database is not configured.');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }

  const response = await fetch(databaseUrl(table, params), {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Supabase request failed: ${response.status} ${text}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function selectParams({ select = '*', filters = {}, order, limit, offset } = {}) {
  const params = new URLSearchParams();
  params.set('select', select);
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  });
  if (order) params.set('order', order);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  return params;
}

async function selectRows(table, options = {}) {
  return databaseRequest(table, {
    params: selectParams(options)
  });
}

async function selectOne(table, options = {}) {
  const rows = await selectRows(table, { ...options, limit: 1 });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function insertRow(table, row) {
  const rows = await databaseRequest(table, {
    method: 'POST',
    body: row,
    headers: { Prefer: 'return=representation' }
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function updateRows(table, filters, patch) {
  const params = selectParams({ filters });
  const rows = await databaseRequest(table, {
    method: 'PATCH',
    params,
    body: patch,
    headers: { Prefer: 'return=representation' }
  });
  return Array.isArray(rows) ? rows : [];
}

async function upsertRows(table, rows, conflictTarget) {
  const params = new URLSearchParams();
  if (conflictTarget) params.set('on_conflict', conflictTarget);
  return databaseRequest(table, {
    method: 'POST',
    params,
    body: rows,
    headers: {
      Prefer: 'resolution=merge-duplicates,return=representation'
    }
  });
}

export {
  databaseEnabled,
  databaseRequest,
  insertRow,
  selectOne,
  selectRows,
  updateRows,
  upsertRows
};
