// Protected endpoint to charge one saved Stripe payment method for a final balance.
//
// POST /api/charge-final-balance
// Header: x-admin-token: ADMIN_TOKEN or FINAL_CHARGE_ADMIN_TOKEN
// Body: { "reservation_record_id": "rec..." }

import { chargeFinalBalanceReservation } from '../../lib/final-balance.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await checkRateLimit(req, res, { maxRequests: 3, windowSeconds: 60, keyPrefix: 'money-single' }))) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    const reservationId = String(req.body?.reservation_record_id || '').trim();
    if (!reservationId.startsWith('rec')) {
      return res.status(400).json({ error: 'Missing reservation_record_id' });
    }

    const result = await chargeFinalBalanceReservation(reservationId);

    return res.status(200).json(result);
  } catch (err) {
    console.error('Final balance charge error:', err);
    return res.status(400).json({ error: err.message || 'Could not charge final balance.' });
  }
}
