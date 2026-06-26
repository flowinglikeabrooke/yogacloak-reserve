// Protected endpoint: releases unpaid checkout holds after the hold window.
// POST /api/cleanup-pending-checkouts with x-admin-token.

import {
  TABLES,
  listRecords,
  notesWith,
  parseNotes,
  requireAdmin,
  updateRecord
} from '../yogacloak-ops.js';

const HOLD_MS = Number(process.env.PENDING_HOLD_MINUTES || 120) * 60 * 1000;

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const records = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: "{Reservation Status}='Pending Payment'"
    }));
    const expired = [];
    const skipped = [];
    const now = Date.now();

    for (const record of records) {
      const fields = record.fields || {};
      const notes = parseNotes(fields.Notes);
      const startedAt = notes.checkout_started_at ? Date.parse(notes.checkout_started_at) : 0;

      if (!startedAt || now - startedAt < HOLD_MS) {
        skipped.push(record.id);
        continue;
      }

      await updateRecord(TABLES.reservations, record.id, {
        'Reservation Status': 'Expired',
        Notes: notesWith(fields, {
          expired_at: new Date().toISOString(),
          expired_reason: 'Stripe checkout not completed within hold window'
        })
      });

      expired.push(record.id);
    }

    return res.status(200).json({ ok: true, expired, skipped });
  } catch (err) {
    console.error('Pending checkout cleanup error:', err);
    return res.status(500).json({ error: 'Could not clean up pending checkouts.' });
  }
}
