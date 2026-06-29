// Vercel endpoint: /api/availability
// Counts active Airtable reservations and returns remaining first-drop spots.

import { databaseEnabled, selectRows } from '../../lib/database.js';

const LEGACY_TOTAL = Number(process.env.DROP_TOTAL || 0);
const WRAP_TOTAL = Number(process.env.WRAP_DROP_TOTAL || LEGACY_TOTAL || 101);
const CLOAK_TOTAL_PER_SIZE = Number(process.env.CLOAK_DROP_TOTAL_PER_SIZE || LEGACY_TOTAL || 50);
const CLOAK_SIZES = ['s_m', 'l_xl'];
const RESERVATIONS_TABLE = process.env.AIRTABLE_RESERVATIONS_TABLE || 'tbliv6V2gDUOhRmf3';
const PRODUCTS_TABLE = process.env.AIRTABLE_PRODUCTS_TABLE || 'tblrPh8y0CY61PqaF';
const PENDING_HOLD_MS = Number(process.env.PENDING_HOLD_MINUTES || 120) * 60 * 1000;
const ACTIVE_STATUSES = [
  'Reserved',
  'Pending Payment',
  'Confirmed',
  'Final Balance Notice Sent',
  'Converted to Order'
];

async function airtableRequest(path) {
  const pat = process.env.AIRTABLE_PAT;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!pat || !baseId) throw new Error('Missing Airtable env vars');

  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${path}`, {
    headers: { Authorization: `Bearer ${pat}` }
  });

  if (!response.ok) {
    throw new Error(`Airtable request failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function productIdMap() {
  if (!PRODUCTS_TABLE) return {};
  const params = new URLSearchParams({
    filterByFormula: "OR({Product Name}='The Cloak',{Product Name}='The Wrap')"
  });
  const data = await airtableRequest(`${PRODUCTS_TABLE}?${params}`);
  const map = {};
  for (const record of data.records || []) {
    if (record.fields['Product Name'] === 'The Cloak') map.cloak = record.id;
    if (record.fields['Product Name'] === 'The Wrap') map.wrap = record.id;
  }
  return map;
}

function parseNotes(value) {
  try {
    if (!value) return {};
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (err) {
    return {};
  }
}

function productKeysFromRecord(record, products) {
  const fields = record.fields || {};
  const linkedProducts = fields.Product || [];
  const rawNotes = fields.Notes || '';
  const notes = parseNotes(rawNotes);
  const keys = new Set();
  const notedProducts = Array.isArray(notes.products)
    ? notes.products
    : String(notes.products || notes.product_selection || '').split(/[,+]/);

  notedProducts.map((item) => String(item).trim().toLowerCase()).forEach((item) => {
    if (item.includes('cloak')) keys.add('cloak');
    if (item.includes('wrap')) keys.add('wrap');
  });

  if (products.cloak && linkedProducts.includes(products.cloak)) keys.add('cloak');
  if (products.wrap && linkedProducts.includes(products.wrap)) keys.add('wrap');

  const noteText = typeof rawNotes === 'string' ? rawNotes.toLowerCase() : JSON.stringify(rawNotes).toLowerCase();
  if (noteText.includes('cloak')) keys.add('cloak');
  if (noteText.includes('wrap')) keys.add('wrap');

  return keys;
}

function cloakSizeKey(record) {
  const fields = record.fields || {};
  const notes = parseNotes(fields.Notes || '');
  const value = String(fields['Size Reserved'] || fields.Size || notes.cloak_size || notes.size || '').toLowerCase();
  if (value.includes('l') || value.includes('xl')) return 'l_xl';
  if (value.includes('s') || value.includes('m')) return 's_m';
  return '';
}

function productKeysFromValue(value) {
  const keys = new Set();
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,+]/)
      : value && typeof value === 'object'
        ? Object.values(value)
        : [];
  raw.map((item) => String(item || '').trim().toLowerCase()).forEach((item) => {
    if (item.includes('cloak')) keys.add('cloak');
    if (item.includes('wrap')) keys.add('wrap');
  });
  return keys;
}

async function loadCrmReservations() {
  if (!databaseEnabled()) return [];
  try {
    return await selectRows('reservations', {
      select: 'id,airtable_reservation_id,status,product_selection,size,notes,created_at',
      order: 'updated_at.desc',
      limit: 500
    }).then((rows) => (rows || []).filter((row) => ACTIVE_STATUSES.includes(row.status)));
  } catch (err) {
    console.warn('Availability CRM reservation lookup warning:', err.message);
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Missing Airtable availability configuration.' });
  }

  try {
    let products = {};
    try {
      products = await productIdMap();
    } catch (err) {
      console.error('Availability product lookup warning:', err);
    }
    let offset = '';
    let cloakTaken = 0;
    const cloakTakenBySize = Object.fromEntries(CLOAK_SIZES.map((size) => [size, 0]));
    let wrapTaken = 0;
    const seenAirtableReservationIds = new Set();

    do {
      const params = new URLSearchParams({
        pageSize: '100',
        filterByFormula: `OR(${ACTIVE_STATUSES.map((status) => `{Reservation Status}='${status}'`).join(',')})`
      });
      if (offset) params.set('offset', offset);

      const data = await airtableRequest(`${RESERVATIONS_TABLE}?${params}`);
      for (const record of data.records || []) {
        const status = record.fields?.['Reservation Status'] || '';
        const rawNotes = String(record.fields?.Notes || '');
        if (status === 'Pending Payment') {
          const notesJson = parseNotes(rawNotes);
          const startedAt = notesJson.checkout_started_at ? Date.parse(notesJson.checkout_started_at) : 0;
          if (!startedAt || Date.now() - startedAt > PENDING_HOLD_MS) continue;
        }
        const keys = productKeysFromRecord(record, products);
        seenAirtableReservationIds.add(record.id);
        if (keys.has('cloak')) {
          cloakTaken += 1;
          const sizeKey = cloakSizeKey(record);
          if (sizeKey && cloakTakenBySize[sizeKey] !== undefined) cloakTakenBySize[sizeKey] += 1;
        }
        if (keys.has('wrap')) wrapTaken += 1;
      }
      offset = data.offset || '';
    } while (offset);

    const crmReservations = await loadCrmReservations();
    for (const row of crmReservations || []) {
      if (row.airtable_reservation_id && seenAirtableReservationIds.has(row.airtable_reservation_id)) continue;
      const keys = productKeysFromValue(row.product_selection || row.notes?.products || row.notes?.inferred_products);
      if (keys.has('cloak')) {
        cloakTaken += 1;
        const rawSize = String(row.size || row.notes?.cloak_size || '').toLowerCase();
        const sizeKey = rawSize.includes('l') || rawSize.includes('xl') ? 'l_xl' : rawSize.includes('s') || rawSize.includes('m') ? 's_m' : '';
        if (sizeKey && cloakTakenBySize[sizeKey] !== undefined) cloakTakenBySize[sizeKey] += 1;
      }
      if (keys.has('wrap')) wrapTaken += 1;
    }

    const cloakBySize = Object.fromEntries(CLOAK_SIZES.map((size) => [
      size,
      Math.max(0, CLOAK_TOTAL_PER_SIZE - cloakTakenBySize[size])
    ]));
    const cloakRemaining = Object.values(cloakBySize).reduce((sum, value) => sum + value, 0);

    return res.status(200).json({
      cloak: cloakRemaining,
      cloak_by_size: cloakBySize,
      wrap: Math.max(0, WRAP_TOTAL - wrapTaken),
      totals: {
        cloak_per_size: CLOAK_TOTAL_PER_SIZE,
        cloak_total: CLOAK_TOTAL_PER_SIZE * CLOAK_SIZES.length,
        wrap: WRAP_TOTAL
      },
      taken: { cloak: cloakTaken, cloak_by_size: cloakTakenBySize, wrap: wrapTaken }
    });
  } catch (err) {
    console.error('Availability endpoint error:', err);
    return res.status(500).json({ error: 'Could not fetch availability.' });
  }
}
