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
} from '../../lib/yogacloak-ops.js';
import { readinessForFields } from '../../lib/final-balance.js';
import { loadSecurityStatus } from '../../lib/security-status.js';

function finalBalanceSafety() {
  const security = loadSecurityStatus();
  return {
    stripe_mode: security.stripe_mode,
    allow_live_final_charges: security.allow_live_final_charges,
    notice_hours: Number(process.env.FINAL_BALANCE_NOTICE_HOURS || 24),
    stripe_webhook_secret_configured: security.stripe_webhook_secret_configured,
    warning: security.stripe_mode === 'live' && !security.allow_live_final_charges
      ? 'Live final-balance charges are locked until ALLOW_LIVE_FINAL_CHARGES=true.'
      : ''
  };
}

function finalBalanceSummary(rows) {
  const groups = {};
  let readyAmount = 0;
  let selectedCandidateAmount = 0;
  rows.forEach((row) => {
    const group = row.readiness_group || 'Blocked';
    groups[group] = (groups[group] || 0) + 1;
    if (row.charge_eligible && !row.already_charged) readyAmount += Number(row.final_balance_total || 0);
    if (!row.already_charged && row.stripe_payment_method_saved) selectedCandidateAmount += Number(row.final_balance_total || 0);
  });
  return {
    groups,
    ready_to_charge_amount: Number(readyAmount.toFixed(2)),
    saved_payment_method_open_amount: Number(selectedCandidateAmount.toFixed(2))
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const status = String(req.query?.status || '').trim();
    const emailSearch = String(req.query?.email || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query?.limit || 500) || 500, 1), 500);
    const statuses = status ? [status] : [...ACTIVE_RESERVATION_STATUSES, 'Expired', 'Cancelled', 'Cancelled + Refunded', 'Transferred'];
    const records = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: statusFormula(statuses)
    }));

    const rows = [];
    for (const record of records.slice(0, limit)) {
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
        final_balance_total: readiness.amount,
        size: fields['Size Reserved'] || notes.cloak_size || '',
        reservation_date: fields['Reservation Date'] || '',
        checkout_started_at: notes.checkout_started_at || '',
        paid_at: notes.paid_at || '',
        abandoned_email_sent_at: notes.abandoned_email_sent_at || '',
        final_balance_notice_sent_at: notes.final_balance_notice_sent_at || '',
        final_balance_status: notes.final_balance_status || '',
        final_balance_last_attempt_at: notes.final_balance_last_attempt_at || '',
        final_balance_last_error: notes.final_balance_last_error || '',
        notice_required: readiness.notice_required,
        notice_status: readiness.notice_status,
        notice_wait_remaining_hours: readiness.notice_wait_remaining_hours,
        charge_eligible: readiness.charge_eligible,
        readiness_group: readiness.readiness_group,
        blocked_reason: readiness.blocked_reason,
        stripe_payment_method_saved: readiness.stripe_payment_method_saved,
        future_charge_authorized: readiness.future_charge_authorized,
        already_charged: readiness.already_charged,
        stripe_checkout_session_id: notes.stripe_checkout_session_id || ''
      });
    }

    rows.sort((a, b) => String(b.checkout_started_at || b.reservation_date).localeCompare(String(a.checkout_started_at || a.reservation_date)));
    return res.status(200).json({
      ok: true,
      reservations: rows,
      final_balance_safety: finalBalanceSafety(),
      final_balance_summary: finalBalanceSummary(rows),
      records_available: records.length,
      records_returned: rows.length,
      record_limit: limit,
      has_more: records.length > limit
    });
  } catch (err) {
    console.error('Admin reservations error:', err);
    return res.status(500).json({ error: 'Could not load reservations.' });
  }
}
