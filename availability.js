// Vercel endpoint: /api/availability
// Counts active Airtable reservations and returns remaining first-drop spots.

const TOTAL = Number(process.env.DROP_TOTAL || 100);
const RESERVATIONS_TABLE = process.env.AIRTABLE_RESERVATIONS_TABLE || 'tbliv6V2gDUOhRmf3';
const PRODUCTS_TABLE = process.env.AIRTABLE_PRODUCTS_TABLE || 'tblrPh8y0CY61PqaF';

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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE_ID) {
    return res.status(200).json({ cloak: TOTAL, wrap: TOTAL });
  }

  try {
    const products = await productIdMap();
    let offset = '';
    let cloakTaken = 0;
    let wrapTaken = 0;

    do {
      const params = new URLSearchParams({
        pageSize: '100',
        filterByFormula: "OR({Reservation Status}='Reserved',{Reservation Status}='Pending Payment',{Reservation Status}='Confirmed')"
      });
      if (offset) params.set('offset', offset);

      const data = await airtableRequest(`${RESERVATIONS_TABLE}?${params}`);
      for (const record of data.records || []) {
        const linkedProducts = record.fields?.Product || [];
        const notes = String(record.fields?.Notes || '').toLowerCase();
        if (linkedProducts.includes(products.cloak) || notes.includes('cloak')) cloakTaken += 1;
        if (linkedProducts.includes(products.wrap) || notes.includes('wrap')) wrapTaken += 1;
      }
      offset = data.offset || '';
    } while (offset);

    return res.status(200).json({
      cloak: Math.max(0, TOTAL - cloakTaken),
      wrap: Math.max(0, TOTAL - wrapTaken)
    });
  } catch (err) {
    console.error('Availability endpoint error:', err);
    return res.status(200).json({ cloak: TOTAL, wrap: TOTAL });
  }
}
