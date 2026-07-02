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
  requireOwner,
  statusFormula
} from '../../lib/yogacloak-ops.js';
import { readinessForFields } from '../../lib/final-balance.js';
import { loadSecurityStatus } from '../../lib/security-status.js';
import { databaseEnabled, selectRows } from '../../lib/database.js';

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

function productText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(' + ');
  if (value && typeof value === 'object') {
    try {
      if (Array.isArray(value)) return value.join(' + ');
      return JSON.stringify(value);
    } catch (err) {
      return '';
    }
  }
  return String(value || '');
}

const DEPOSIT_PAID_STATUSES = new Set(['Reserved', 'Confirmed', 'Final Balance Notice Sent', 'Converted to Order']);

function crmReservationReadiness(row) {
  const amount = Number(row.final_balance_total || 0);
  const charged = Boolean(row.final_balance_payment_intent_id || row.final_balance_charged_at || row.final_balance_status === 'charged');
  const depositPaid = DEPOSIT_PAID_STATUSES.has(String(row.status || '').trim());
  const noticeSent = Boolean(row.final_balance_notice_sent_at);
  const noticeHours = Number(process.env.FINAL_BALANCE_NOTICE_HOURS || 24);
  const ageHours = noticeSent ? (Date.now() - Date.parse(row.final_balance_notice_sent_at)) / (1000 * 60 * 60) : 0;
  const waitRemaining = noticeSent ? Math.max(0, noticeHours - ageHours) : 0;
  const savedMethod = Boolean(row.stripe_customer_id && row.stripe_payment_method_id);
  const canAutoCharge = Boolean(depositPaid && row.airtable_reservation_id && savedMethod && row.future_charge_authorized && amount > 0);
  const blockedReasons = [];
  if (!depositPaid) blockedReasons.push('Deposit not paid. Stripe has not confirmed this checkout, so there is no balance to collect yet.');
  if (!row.airtable_reservation_id) blockedReasons.push('Private CRM-only reservation; send a manual notice/payment link unless this is reconnected to its original reservation checkout.');
  if (!savedMethod) blockedReasons.push('No saved Stripe customer/payment method was found.');
  if (!row.future_charge_authorized) blockedReasons.push('Future-charge permission was not found on this Stripe payment.');
  if (!amount) blockedReasons.push('No remaining balance is saved.');

  let readinessGroup = 'Blocked';
  if (charged) readinessGroup = 'Already Charged';
  else if (depositPaid && !noticeSent && amount > 0) readinessGroup = 'Needs Notice';
  else if (canAutoCharge && waitRemaining > 0) readinessGroup = 'Waiting Period';
  else if (canAutoCharge && noticeSent && waitRemaining <= 0) readinessGroup = 'Ready to Charge';

  let noticeStatus = 'Blocked';
  if (charged) noticeStatus = 'Already charged';
  else if (!depositPaid) noticeStatus = 'Deposit not paid';
  else if (!noticeSent && amount > 0) noticeStatus = canAutoCharge ? 'Notice not sent' : 'Manual notice/payment link needed';
  else if (waitRemaining > 0) noticeStatus = `Notice sent; wait ${Number(waitRemaining.toFixed(1))}h`;
  else if (noticeSent) noticeStatus = canAutoCharge ? 'Notice wait complete' : 'Notice sent; auto-charge blocked';

  return {
    amount,
    already_charged: charged,
    blocked_reason: charged || canAutoCharge ? '' : blockedReasons.join(' '),
    charge_eligible: Boolean(canAutoCharge && noticeSent && waitRemaining <= 0 && !charged),
    final_balance_notice_sent_at: row.final_balance_notice_sent_at || '',
    future_charge_authorized: Boolean(row.future_charge_authorized),
    notice_required: Boolean(canAutoCharge && !noticeSent && !charged),
    notice_status: noticeStatus,
    notice_wait_remaining_hours: Number(waitRemaining.toFixed(2)),
    readiness_group: readinessGroup,
    stripe_payment_method_saved: savedMethod
  };
}

async function loadCrmOnlyReservations({ seenAirtableIds = new Set(), limit = 250 } = {}) {
  if (!databaseEnabled()) return [];
  try {
    const rows = await selectRows('reservations', {
      select: '*,customers(id,full_name,email,phone,status)',
      order: 'updated_at.desc',
      limit
    });
    return (rows || [])
      .filter((row) => !row.airtable_reservation_id || !seenAirtableIds.has(row.airtable_reservation_id))
      .filter((row) => Number(row.final_balance_total || 0) > 0 || row.final_balance_payment_intent_id)
      .map((row) => {
        const readiness = crmReservationReadiness(row);
        return {
          id: `crm:${row.id}`,
          crm_reservation_id: row.id,
          customer_id: row.customer_id || row.customers?.id || '',
          status: row.status || '',
          final_checkout_status: row.final_balance_status || '',
          customer_name: row.customers?.full_name || 'Customer',
          email: row.customers?.email || '',
          product: productText(row.product_selection || row.product || 'Reservation') || 'Reservation',
          deposit_amount: row.deposit_amount || 0,
          final_retail_total: row.final_retail_total || 0,
          final_balance_total: readiness.amount,
          size: row.size || '',
          reservation_date: row.created_at || '',
          checkout_started_at: row.created_at || '',
          paid_at: row.updated_at || '',
          abandoned_email_sent_at: '',
          final_balance_notice_sent_at: row.final_balance_notice_sent_at || '',
          final_balance_status: row.final_balance_status || '',
          final_balance_last_attempt_at: row.notes?.final_balance_last_attempt_at || '',
          final_balance_last_error: row.notes?.final_balance_last_error || '',
          notice_required: readiness.notice_required,
          notice_status: readiness.notice_status,
          notice_wait_remaining_hours: readiness.notice_wait_remaining_hours,
          charge_eligible: readiness.charge_eligible,
          readiness_group: readiness.readiness_group,
          blocked_reason: readiness.blocked_reason,
          stripe_payment_method_saved: readiness.stripe_payment_method_saved,
          future_charge_authorized: readiness.future_charge_authorized,
          already_charged: readiness.already_charged,
          stripe_checkout_session_id: row.checkout_session_id || '',
          admin_selectable: Boolean(row.airtable_reservation_id)
        };
      });
  } catch (err) {
    console.warn('Could not load CRM-only reservations for final balances:', err.message);
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireOwner(req, res)) return;

  try {
    const status = String(req.query?.status || '').trim();
    const emailSearch = String(req.query?.email || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query?.limit || 500) || 500, 1), 500);
    const statuses = status ? [status] : [...ACTIVE_RESERVATION_STATUSES, 'Expired', 'Cancelled', 'Cancelled + Refunded', 'Transferred'];
    const records = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: statusFormula(statuses)
    }));

    const rows = [];
    const seenAirtableIds = new Set();
    for (const record of records.slice(0, limit)) {
      const fields = record.fields || {};
      const notes = parseNotes(fields.Notes);
      const readiness = readinessForFields(fields);
      const contact = await contactForReservation(fields);
      const email = contactEmail(contact);
      if (emailSearch && !email.includes(emailSearch)) continue;

      rows.push({
        id: record.id,
        admin_selectable: true,
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
      seenAirtableIds.add(record.id);
    }

    const crmOnlyRows = await loadCrmOnlyReservations({ seenAirtableIds, limit });
    rows.push(...crmOnlyRows);

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
