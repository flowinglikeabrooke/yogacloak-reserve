// Protected endpoint: checks for Stripe/Airtable reservation data gaps.
// GET /api/reconcile-stripe-airtable with Authorization: Bearer CRON_SECRET.

import {
  ACTIVE_RESERVATION_STATUSES,
  TABLES,
  contactEmail,
  contactForReservation,
  listRecords,
  notesWith,
  parseNotes,
  productLabel,
  requireAdmin,
  sendEmail,
  statusFormula,
  stripeRequest,
  updateRecord
} from '../yogacloak-ops.js';
import { createCustomerEvent, updateReservationByAirtableId } from '../customer-identity.js';
import { notificationEmailsFor } from '../admin-notifications.js';

const PAID_LOOKING_STATUSES = new Set(['Reserved', 'Confirmed', 'Final Balance Notice Sent', 'Converted to Order']);

// Verifies a paid-looking reservation against Stripe (payment source of truth).
// Returns { verified, correction } where correction is the status the record
// should be downgraded to when Stripe has no successful payment for it.
async function verifyReservationAgainstStripe(fields, notes, hasPaymentLink) {
  if (hasPaymentLink) return { verified: true };

  if (notes.stripe_payment_intent_id) {
    try {
      const intent = await stripeRequest(`payment_intents/${encodeURIComponent(notes.stripe_payment_intent_id)}`);
      if (intent.status === 'succeeded') return { verified: true };
    } catch (err) {
      return { verified: false, correction: '', reason: `Could not verify Stripe payment intent: ${err.message}` };
    }
  }

  if (notes.stripe_checkout_session_id) {
    try {
      const session = await stripeRequest(`checkout/sessions/${encodeURIComponent(notes.stripe_checkout_session_id)}`);
      if (session.payment_status === 'paid') return { verified: true };
      if (session.status === 'open') return { verified: false, correction: 'Pending Payment', reason: 'Stripe checkout is still open and unpaid.' };
      return { verified: false, correction: 'Expired', reason: `Stripe checkout ${session.status || 'closed'} without payment.` };
    } catch (err) {
      return { verified: false, correction: '', reason: `Could not verify Stripe checkout session: ${err.message}` };
    }
  }

  return {
    verified: false,
    correction: 'Pending Payment',
    reason: 'No Stripe payment, payment intent, or checkout session backs this reservation.'
  };
}

async function correctUnpaidReservation(reservation, fields, correction, reason) {
  const now = new Date().toISOString();
  await updateRecord(TABLES.reservations, reservation.id, {
    'Reservation Status': correction,
    Notes: notesWith(fields, {
      needs_review: true,
      backfill_corrected_at: now,
      backfill_previous_status: fields['Reservation Status'] || '',
      backfill_reason: reason
    })
  });
  try {
    const rows = await updateReservationByAirtableId(reservation.id, { status: correction });
    const row = rows[0];
    if (row?.customer_id) {
      await createCustomerEvent({
        customerId: row.customer_id,
        type: 'reservation_backfill_corrected',
        title: 'Reservation corrected: deposit not paid',
        details: `Status changed from ${fields['Reservation Status'] || 'unknown'} to ${correction}. ${reason}`,
        metadata: { airtable_reservation_id: reservation.id, previous_status: fields['Reservation Status'] || '', corrected_status: correction }
      });
    }
  } catch (err) {
    console.warn('Supabase backfill correction save failed; Airtable was already corrected:', err.message);
  }
}

function ownerEmail() {
  return notificationEmailsFor('owners');
}

function issueRow(issue) {
  return `
    <tr>
      <td style="padding:10px 0;border-top:1px solid rgba(251,248,240,.12);color:rgba(251,248,240,.78);font-size:13px">${issue.kind}<br><span style="color:rgba(251,248,240,.45)">${issue.id}</span></td>
      <td style="padding:10px 0;border-top:1px solid rgba(251,248,240,.12);color:rgba(251,248,240,.72);font-size:13px;text-align:right">${issue.product || ''}<br><span style="color:rgba(251,248,240,.45)">${issue.email || ''}</span></td>
    </tr>
  `;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    // POST { "fix": true } corrects paid-looking reservations that Stripe cannot
    // confirm. GET (the daily cron) stays report-only.
    const fix = req.method === 'POST' && req.body?.fix === true;
    const statuses = [...ACTIVE_RESERVATION_STATUSES, 'Expired', 'Cancelled', 'Transferred'];
    const reservations = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: statusFormula(statuses)
    }));
    const payments = await listRecords(TABLES.payments);
    const issues = [];
    const corrections = [];

    const paymentReservationIds = new Set();
    payments.forEach((payment) => {
      const linked = payment.fields?.Reservation || [];
      linked.forEach((id) => paymentReservationIds.add(id));
      if (!linked.length) {
        issues.push({
          kind: 'Payment missing reservation link',
          id: payment.id,
          email: '',
          product: payment.fields?.['Stripe Transaction ID'] || ''
        });
      }
    });

    for (const reservation of reservations) {
      const fields = reservation.fields || {};
      const notes = parseNotes(fields.Notes);
      const status = fields['Reservation Status'] || '';
      const contact = await contactForReservation(fields);
      const base = {
        id: reservation.id,
        email: contactEmail(contact),
        product: productLabel(notes, fields)
      };

      const hasPaymentLink = paymentReservationIds.has(reservation.id) || (fields.Payment || []).length > 0;
      if (PAID_LOOKING_STATUSES.has(status) && !hasPaymentLink) {
        issues.push({ ...base, kind: `${status} but missing payment link` });
        if (fix) {
          const verdict = await verifyReservationAgainstStripe(fields, notes, hasPaymentLink);
          if (!verdict.verified && verdict.correction) {
            await correctUnpaidReservation(reservation, fields, verdict.correction, verdict.reason);
            corrections.push({ ...base, previous_status: status, corrected_status: verdict.correction, reason: verdict.reason });
          } else if (!verdict.verified) {
            corrections.push({ ...base, previous_status: status, corrected_status: '', reason: `Needs manual review: ${verdict.reason}` });
          }
        }
      }
      if ((status === 'Reserved' || status === 'Confirmed') && !notes.stripe_checkout_session_id) {
        issues.push({ ...base, kind: 'Reserved but missing Stripe checkout ID' });
      }
      if ((status === 'Reserved' || status === 'Confirmed') && !notes.stripe_customer_id) {
        issues.push({ ...base, kind: 'Reserved but missing Stripe customer ID' });
      }
      if (status === 'Pending Payment' && !notes.stripe_checkout_url) {
        issues.push({ ...base, kind: 'Pending checkout missing Stripe URL' });
      }
    }

    if (!issues.length) {
      return res.status(200).json({ ok: true, issues: [], corrections });
    }

    const visible = issues.slice(0, 20);
    const subject = `yogacloak reconciliation: ${issues.length} item${issues.length === 1 ? '' : 's'} to check`;
    const html = `
      <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
        <div style="max-width:640px;margin:0 auto">
          <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
          <h1 style="font-size:32px;line-height:1.05;font-weight:500;margin:18px 0">A few records need a look.</h1>
          <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">The daily Stripe/Airtable check found ${issues.length} possible data gap${issues.length === 1 ? '' : 's'}.</p>
          <table style="width:100%;border-collapse:collapse;margin-top:16px">${visible.map(issueRow).join('')}</table>
        </div>
      </div>
    `;

    await sendEmail({
      to: ownerEmail(),
      subject,
      html,
      text: `Stripe/Airtable reconciliation found ${issues.length} item(s) to check: ${issues.map((issue) => `${issue.kind} ${issue.id}`).join('; ')}`
    });

    return res.status(200).json({ ok: true, issues, corrections });
  } catch (err) {
    console.error('Stripe/Airtable reconciliation error:', err);
    return res.status(500).json({ error: 'Could not run reconciliation.' });
  }
}
