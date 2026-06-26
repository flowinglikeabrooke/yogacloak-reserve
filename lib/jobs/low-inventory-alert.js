// Protected endpoint: emails the owner when first-drop inventory gets low.
// GET /api/low-inventory-alert with Authorization: Bearer CRON_SECRET.

import {
  TABLES,
  listRecords,
  parseNotes,
  requireAdmin,
  sendEmail
} from '../yogacloak-ops.js';

const TOTAL = Number(process.env.DROP_TOTAL || 100);
const THRESHOLD = Number(process.env.LOW_INVENTORY_THRESHOLD || 10);

function ownerEmail() {
  return process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_TO || 'hello@yogacloak.com';
}

async function productIdMap() {
  const data = await listRecords(TABLES.products, new URLSearchParams({
    filterByFormula: "OR({Product Name}='The Cloak',{Product Name}='The Wrap')"
  }));
  const map = {};
  for (const record of data) {
    if (record.fields?.['Product Name'] === 'The Cloak') map.cloak = record.id;
    if (record.fields?.['Product Name'] === 'The Wrap') map.wrap = record.id;
  }
  return map;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const products = await productIdMap();
    const records = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: "OR({Reservation Status}='Reserved',{Reservation Status}='Pending Payment',{Reservation Status}='Confirmed',{Reservation Status}='Final Balance Notice Sent',{Reservation Status}='Converted to Order')"
    }));

    const taken = { cloak: 0, wrap: 0 };
    for (const record of records) {
      const fields = record.fields || {};
      const linkedProducts = fields.Product || [];
      const notes = JSON.stringify(parseNotes(fields.Notes)).toLowerCase();
      if (linkedProducts.includes(products.cloak) || notes.includes('cloak')) taken.cloak += 1;
      if (linkedProducts.includes(products.wrap) || notes.includes('wrap')) taken.wrap += 1;
    }

    const remaining = {
      cloak: Math.max(0, TOTAL - taken.cloak),
      wrap: Math.max(0, TOTAL - taken.wrap)
    };
    const low = Object.entries(remaining).filter(([, count]) => count <= THRESHOLD);

    if (!low.length) {
      return res.status(200).json({ ok: true, alert_sent: false, remaining });
    }

    const subject = `yogacloak inventory low: ${low.map(([key, count]) => `${key} ${count}`).join(', ')}`;
    const html = `
      <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
        <div style="max-width:560px;margin:0 auto">
          <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
          <h1 style="font-size:32px;line-height:1.05;font-weight:500;margin:18px 0">Inventory is getting low.</h1>
          <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">The daily inventory check found one or more products at or below ${THRESHOLD} remaining spots.</p>
          <p style="font-size:15px;line-height:1.8;color:rgba(251,248,240,.82)">The Cloak: ${remaining.cloak} left<br>The Wrap: ${remaining.wrap} left</p>
        </div>
      </div>
    `;

    await sendEmail({
      to: ownerEmail(),
      subject,
      html,
      text: `Low inventory: The Cloak ${remaining.cloak} left, The Wrap ${remaining.wrap} left.`
    });

    return res.status(200).json({ ok: true, alert_sent: true, remaining });
  } catch (err) {
    console.error('Low inventory alert error:', err);
    return res.status(500).json({ error: 'Could not run low inventory alert.' });
  }
}
