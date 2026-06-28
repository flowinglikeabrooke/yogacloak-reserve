// Protected endpoint: lightweight reservation/customer status view.
// GET /api/admin-reservations?status=Reserved&email=name@example.com

import {
  ACTIVE_RESERVATION_STATUSES,
  TABLES,
  contactEmail,
  contactForReservation,
  contactName,
  listRecords,
  parseNotes,
  productLabel,
  requireAdmin,
  statusFormula
} from '../lib/yogacloak-ops.js';
import { readinessForFields } from '../lib/final-balance.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const status = String(req.query?.status || '').trim();
    const emailSearch = String(req.query?.email || '').trim().toLowerCase();
    const statuses = status ? [status] : [...ACTIVE_RESERVATION_STATUSES, 'Expired', 'Cancelled', 'Transferred'];
    const records = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: statusFormula(statuses)
    }));

    const rows = [];
    for (const record of records.slice(0, 100)) {
      const fields = record.fields || {};
      const notes = parseNotes(fields.Notes);
      const readiness = readinessForFields(fields);
      const contact = await contactForReservation(fields);
      const email = contactEmail(contact);
      if (emailSearch && !email.includes(emailSearch)) continue;

      rows.push({
        id: record.id,
        status: fields['Reservation Status'] || '',
        final_checkout_status: fields['Final Checkout Status'] || '',
        customer_name: contactName(contact),
        email,
        product: productLabel(notes, fields),
        deposit_amount: fields['Deposit Amount'] || 0,
        final_retail_total: fields['Final Retail Total'] || 0,
        final_balance_total: notes.final_balance_total || '',
        size: fields['Size Reserved'] || notes.cloak_size || '',
        reservation_date: fields['Reservation Date'] || '',
        checkout_started_at: notes.checkout_started_at || '',
        paid_at: notes.paid_at || '',
        abandoned_email_sent_at: notes.abandoned_email_sent_at || '',
        final_balance_notice_sent_at: notes.final_balance_notice_sent_at || '',
        notice_required: readiness.notice_required,
        notice_wait_remaining_hours: readiness.notice_wait_remaining_hours,
        charge_eligible: readiness.charge_eligible,
        readiness_group: readiness.readiness_group,
        blocked_reason: readiness.blocked_reason,
        stripe_payment_method_saved: readiness.stripe_payment_method_saved,
        future_charge_authorized: readiness.future_charge_authorized,
        already_charged: readiness.already_charged,
        stripe_customer_id: notes.stripe_customer_id || '',
        stripe_payment_method_id: notes.stripe_payment_method_id || '',
        stripe_checkout_session_id: notes.stripe_checkout_session_id || ''
      });
    }

    rows.sort((a, b) => String(b.checkout_started_at || b.reservation_date).localeCompare(String(a.checkout_started_at || a.reservation_date)));
    return res.status(200).json({ ok: true, reservations: rows });
  } catch (err) {
    console.error('Admin reservations error:', err);
    return res.status(500).json({ error: 'Could not load reservations.' });
  }
}
