// Protected endpoint: cancel, refund, or transfer a reservation.
// POST /api/manage-reservation with x-admin-token.
// Body examples:
// { "reservation_record_id":"rec...", "action":"cancel", "reason":"Customer request" }
// { "reservation_record_id":"rec...", "action":"cancel", "refund_deposit":true, "reason":"yogacloak cancelled" }
// { "reservation_record_id":"rec...", "action":"transfer", "new_email":"friend@example.com", "new_first_name":"Friend", "new_last_name":"Name" }

import {
  TABLES,
  clean,
  createRecord,
  getRecord,
  checkRateLimit,
  notesWith,
  parseNotes,
  rejectLargeRequest,
  requireAdmin,
  stripeRequest,
  updateRecord
} from '../../lib/yogacloak-ops.js';

async function refundDeposit(notes, reservationId) {
  const paymentIntentId = notes.stripe_payment_intent_id;
  if (!paymentIntentId) throw new Error('Reservation is missing Stripe payment intent.');

  const params = new URLSearchParams();
  params.append('payment_intent', paymentIntentId);
  params.append('metadata[reservation_record_id]', reservationId);
  params.append('metadata[refund_type]', 'deposit');

  return stripeRequest('refunds', {
    method: 'POST',
    body: params
  });
}

async function createTransferContact({ firstName, lastName, email }) {
  const fullName = `${firstName} ${lastName}`.trim();
  return createRecord(TABLES.contacts, {
    'Full Name': fullName || email,
    'First Name': firstName,
    'Last Name': lastName,
    Email: email,
    'Contact Type': 'Reserved',
    'Lead Source': 'Transfer',
    'Date Added': new Date().toISOString().slice(0, 10)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'manage-reservation' })) return;
  if (rejectLargeRequest(req, res, 12 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const reservationId = clean(req.body?.reservation_record_id, 40);
    const action = clean(req.body?.action, 40).toLowerCase();
    const reason = clean(req.body?.reason || '', 500);

    if (!reservationId.startsWith('rec')) return res.status(400).json({ error: 'Missing reservation_record_id' });
    if (!['cancel', 'transfer', 'mark_refunded'].includes(action)) {
      return res.status(400).json({ error: 'Action must be cancel, transfer, or mark_refunded.' });
    }

    const reservation = await getRecord(TABLES.reservations, reservationId);
    const fields = reservation.fields || {};
    const notes = parseNotes(fields.Notes);
    const now = new Date().toISOString();

    if (action === 'cancel') {
      let refund = null;
      if (req.body?.refund_deposit === true) {
        refund = await refundDeposit(notes, reservationId);
      }

      await updateRecord(TABLES.reservations, reservationId, {
        'Reservation Status': req.body?.refund_deposit === true ? 'Cancelled + Refunded' : 'Cancelled',
        'Final Checkout Status': 'Cancelled',
        Notes: notesWith(fields, {
          cancelled_at: now,
          cancellation_reason: reason,
          deposit_refund_id: refund?.id || notes.deposit_refund_id || '',
          deposit_refunded_at: refund ? now : notes.deposit_refunded_at || ''
        })
      });

      return res.status(200).json({ ok: true, action, refund_id: refund?.id || null });
    }

    if (action === 'mark_refunded') {
      await updateRecord(TABLES.reservations, reservationId, {
        'Reservation Status': 'Cancelled + Refunded',
        Notes: notesWith(fields, {
          deposit_refunded_at: now,
          refund_note: reason
        })
      });
      return res.status(200).json({ ok: true, action });
    }

    const newEmail = clean(req.body?.new_email, 200).toLowerCase();
    const newFirstName = clean(req.body?.new_first_name, 100);
    const newLastName = clean(req.body?.new_last_name, 100);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: 'Transfer needs a valid new_email.' });
    }

    const originalContact = Array.isArray(fields.Contact) ? fields.Contact[0] : '';
    const newContact = await createTransferContact({
      firstName: newFirstName,
      lastName: newLastName,
      email: newEmail
    });

    await updateRecord(TABLES.reservations, reservationId, {
      Contact: [newContact.id],
      'Reservation Status': 'Transferred',
      Notes: notesWith(fields, {
        transferred_at: now,
        transfer_reason: reason,
        original_contact_id: originalContact,
        new_contact_id: newContact.id,
        new_contact_email: newEmail
      })
    });

    return res.status(200).json({ ok: true, action, new_contact_id: newContact.id });
  } catch (err) {
    console.error('Manage reservation error:', err);
    return res.status(500).json({ error: 'Could not update reservation.' });
  }
}
