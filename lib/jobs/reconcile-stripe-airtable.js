// Protected endpoint: checks for Stripe/Airtable reservation data gaps.
// GET /api/reconcile-stripe-airtable with Authorization: Bearer CRON_SECRET.

import {
  ACTIVE_RESERVATION_STATUSES,
  TABLES,
  contactEmail,
  contactForReservation,
  listRecords,
  parseNotes,
  productLabel,
  requireAdmin,
  sendEmail,
  statusFormula
} from '../yogacloak-ops.js';

function ownerEmail() {
  return process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_TO || 'hello@yogacloak.com';
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
    const statuses = [...ACTIVE_RESERVATION_STATUSES, 'Expired', 'Cancelled', 'Transferred'];
    const reservations = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: statusFormula(statuses)
    }));
    const payments = await listRecords(TABLES.payments);
    const issues = [];

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

      if ((status === 'Reserved' || status === 'Confirmed') && !paymentReservationIds.has(reservation.id) && !(fields.Payment || []).length) {
        issues.push({ ...base, kind: 'Reserved but missing payment link' });
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
      return res.status(200).json({ ok: true, issues: [] });
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

    return res.status(200).json({ ok: true, issues });
  } catch (err) {
    console.error('Stripe/Airtable reconciliation error:', err);
    return res.status(500).json({ error: 'Could not run reconciliation.' });
  }
}
