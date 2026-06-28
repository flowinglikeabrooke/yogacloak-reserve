// Protected endpoint: emails the customer before charging the final balance.
// POST /api/send-final-balance-notice with x-admin-token.
// Body: { "reservation_record_id": "rec..." }

import { sendFinalBalanceNoticeForReservation } from '../lib/final-balance.js';
import { requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const reservationId = String(req.body?.reservation_record_id || '').trim();
    if (!reservationId.startsWith('rec')) {
      return res.status(400).json({ error: 'Missing reservation_record_id' });
    }

    const result = await sendFinalBalanceNoticeForReservation(reservationId);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Final balance notice error:', err);
    return res.status(400).json({ error: err.message || 'Could not send final-balance notice.' });
  }
}
