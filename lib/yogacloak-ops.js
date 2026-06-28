import { hasAdminSession } from './admin-auth.js';

const TABLES = {
  contacts: process.env.AIRTABLE_CONTACTS_TABLE || 'tbl6mXGzw0Q9GZ3R3',
  forms: process.env.AIRTABLE_FORMS_TABLE || 'tblRvWlirlbzlW5Up',
  reservations: process.env.AIRTABLE_RESERVATIONS_TABLE || 'tbliv6V2gDUOhRmf3',
  payments: process.env.AIRTABLE_PAYMENTS_TABLE || 'tblc9s0jZj549dIGJ',
  products: process.env.AIRTABLE_PRODUCTS_TABLE || 'tblrPh8y0CY61PqaF'
};

const ACTIVE_RESERVATION_STATUSES = [
  'Pending Payment',
  'Reserved',
  'Confirmed',
  'Final Balance Notice Sent',
  'Converted to Order'
];

function adminToken() {
  return process.env.ADMIN_TOKEN || process.env.FINAL_CHARGE_ADMIN_TOKEN;
}

function requireAdmin(req, res) {
  const token = adminToken();
  const cronToken = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const provided = req.headers['x-admin-token'] || bearer;
  const allowed = [token, cronToken].filter(Boolean);
  if (hasAdminSession(req)) return true;
  if (!allowed.length || !allowed.includes(provided)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function parseNotes(value) {
  try {
    if (!value) return {};
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (err) {
    return {};
  }
}

function notesWith(fields, patch) {
  return JSON.stringify({
    ...parseNotes(fields?.Notes),
    ...patch
  });
}

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function escapeFormulaValue(value) {
  return String(value || '').replace(/'/g, "\\'");
}

function statusFormula(statuses = ACTIVE_RESERVATION_STATUSES) {
  return `OR(${statuses.map((status) => `{Reservation Status}='${escapeFormulaValue(status)}'`).join(',')})`;
}

async function airtableRequest(path, options = {}) {
  const pat = process.env.AIRTABLE_PAT;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!pat || !baseId) throw new Error('Missing Airtable env vars');

  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Airtable request failed: ${response.status} ${errorText}`);
  }

  return response.status === 204 ? null : response.json();
}

async function listRecords(tableId, params = new URLSearchParams()) {
  const records = [];
  let offset = null;

  do {
    const pageParams = new URLSearchParams(params);
    pageParams.set('pageSize', pageParams.get('pageSize') || '100');
    if (offset) pageParams.set('offset', offset);
    const data = await airtableRequest(`${tableId}?${pageParams}`);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);

  return records;
}

async function getRecord(tableId, recordId) {
  return airtableRequest(`${tableId}/${recordId}`);
}

async function createRecord(tableId, fields) {
  const data = await airtableRequest(tableId, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  return data.records[0];
}

async function updateRecord(tableId, recordId, fields) {
  return airtableRequest(`${tableId}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields, typecast: true })
  });
}

async function stripeRequest(path, options = {}) {
  const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.RESERVE_STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('Missing STRIPE_SECRET_KEY or RESERVE_STRIPE_SECRET_KEY');

  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Stripe request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Missing RESEND_API_KEY');

  const from = process.env.EMAIL_FROM || 'yogacloak <hello@yogacloak.com>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html, text })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function money(value) {
  return `$${Number(value || 0).toFixed(0)}`;
}

function productLabel(notes, fields = {}) {
  const products = Array.isArray(notes.products)
    ? notes.products
    : String(notes.products || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (products.includes('cloak') && products.includes('wrap')) return 'The Cloak + The Wrap';
  if (products.includes('cloak')) return 'The Cloak';
  if (products.includes('wrap')) return 'The Wrap';
  return fields['Product Interest'] || 'your yogacloak';
}

async function contactForReservation(fields) {
  const contactId = Array.isArray(fields.Contact) ? fields.Contact[0] : null;
  if (!contactId) return null;
  return getRecord(TABLES.contacts, contactId);
}

function contactEmail(contact) {
  return clean(contact?.fields?.Email || contact?.fields?.['Email Address'] || '', 200).toLowerCase();
}

function contactName(contact) {
  return clean(contact?.fields?.['First Name'] || contact?.fields?.['Full Name'] || '', 100);
}

function checkRateLimit(req, res, { maxRequests = 10, windowSeconds = 60 } = {}) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  const key = `ratelimit:${ip}`;

  if (!global._rateLimitStore) global._rateLimitStore = {};

  const store = global._rateLimitStore;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  if (!store[key]) {
    store[key] = [];
  }

  store[key] = store[key].filter(timestamp => now - timestamp < windowMs);

  if (store[key].length >= maxRequests) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return false;
  }

  store[key].push(now);
  res.setHeader('X-RateLimit-Limit', String(maxRequests));
  res.setHeader('X-RateLimit-Remaining', String(maxRequests - store[key].length));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));

  return true;
}

export {
  TABLES,
  ACTIVE_RESERVATION_STATUSES,
  airtableRequest,
  checkRateLimit,
  clean,
  contactEmail,
  contactForReservation,
  contactName,
  createRecord,
  escapeFormulaValue,
  getRecord,
  listRecords,
  money,
  notesWith,
  parseNotes,
  productLabel,
  requireAdmin,
  sendEmail,
  statusFormula,
  stripeRequest,
  updateRecord
};
