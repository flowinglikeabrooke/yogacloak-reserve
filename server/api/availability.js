// Vercel endpoint: /api/availability
// Counts active Airtable reservations and returns remaining first-drop spots.

const TOTAL = Number(process.env.DROP_TOTAL || 100);
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
    let wrapTaken = 0;

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
        if (keys.has('cloak')) cloakTaken += 1;
        if (keys.has('wrap')) wrapTaken += 1;
      }
      offset = data.offset || '';
    } while (offset);

    return res.status(200).json({
      cloak: Math.max(0, TOTAL - cloakTaken),
      wrap: Math.max(0, TOTAL - wrapTaken),
      taken: { cloak: cloakTaken, wrap: wrapTaken }
    });
  } catch (err) {
    console.error('Availability endpoint error:', err);
    return res.status(500).json({ error: 'Could not fetch availability.' });
  }
}
