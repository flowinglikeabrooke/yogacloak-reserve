// Protected endpoint: sends a daily YogaCloak owner summary.
// GET /api/daily-owner-digest with Authorization: Bearer CRON_SECRET.

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
  sendEmail,
  statusFormula
} from '../yogacloak-ops.js';

function ownerEmail() {
  return process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_TO || 'hello@yogacloak.com';
}

function sinceIso(hours = 24) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isoDate(value) {
  if (!value) return '';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString();
}

function after(value, cutoff) {
  const parsed = isoDate(value);
  return parsed && parsed >= cutoff;
}

async function safeList(tableId, params) {
  try {
    return await listRecords(tableId, params);
  } catch (err) {
    console.error(`Digest list failed for ${tableId}:`, err.message);
    return [];
  }
}

async function smsOptInsSince(cutoff) {
  const tableId = process.env.AIRTABLE_SMS_OPTINS_TABLE || process.env.AIRTABLE_SMS_TABLE || '';
  if (!tableId) return 0;
  const records = await safeList(tableId);
  return records.filter((record) => {
    const fields = record.fields || {};
    const notes = parseNotes(fields.Notes);
    return after(fields['Opt-In Timestamp'] || notes.opt_in_timestamp || fields['Submission Date'], cutoff);
  }).length;
}

function rowHtml(rows) {
  if (!rows.length) return '<p style="color:rgba(251,248,240,.56);font-size:14px;line-height:1.6">No fresh reservations in the last 24 hours.</p>';
  return `
    <table style="width:100%;border-collapse:collapse;margin-top:14px">
      ${rows.map((row) => `
        <tr>
          <td style="padding:10px 0;border-top:1px solid rgba(251,248,240,.12);color:rgba(251,248,240,.78);font-size:13px">${row.name || 'Customer'}<br><span style="color:rgba(251,248,240,.45)">${row.email || ''}</span></td>
          <td style="padding:10px 0;border-top:1px solid rgba(251,248,240,.12);color:rgba(251,248,240,.72);font-size:13px;text-align:right">${row.product}<br><span style="color:rgba(251,248,240,.45)">${row.status}</span></td>
        </tr>
      `).join('')}
    </table>
  `;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const cutoff = sinceIso(24);
    const statuses = [...ACTIVE_RESERVATION_STATUSES, 'Expired', 'Cancelled', 'Transferred'];
    const reservations = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: statusFormula(statuses)
    }));

    const counts = {
      pending: 0,
      reserved: 0,
      expired: 0,
      finalNotice: 0,
      converted: 0,
      abandonedSent24h: 0,
      newReservations24h: 0
    };
    const freshRows = [];

    for (const record of reservations) {
      const fields = record.fields || {};
      const notes = parseNotes(fields.Notes);
      const status = fields['Reservation Status'] || '';

      if (status === 'Pending Payment') counts.pending += 1;
      if (status === 'Reserved' || status === 'Confirmed') counts.reserved += 1;
      if (status === 'Expired') counts.expired += 1;
      if (status === 'Final Balance Notice Sent') counts.finalNotice += 1;
      if (status === 'Converted to Order') counts.converted += 1;
      if (after(notes.abandoned_email_sent_at, cutoff)) counts.abandonedSent24h += 1;

      if (after(notes.paid_at || fields['Reservation Date'] || notes.checkout_started_at, cutoff)) {
        counts.newReservations24h += 1;
        if (freshRows.length < 8) {
          const contact = await contactForReservation(fields);
          freshRows.push({
            name: contactName(contact),
            email: contactEmail(contact),
            product: productLabel(notes, fields),
            status
          });
        }
      }
    }

    const sms24h = await smsOptInsSince(cutoff);
    const subject = `yogacloak daily: ${counts.newReservations24h} new, ${counts.pending} pending`;
    const html = `
      <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
        <div style="max-width:620px;margin:0 auto">
          <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
          <h1 style="font-size:34px;line-height:1.05;font-weight:500;margin:18px 0 18px">Daily owner digest.</h1>
          <p style="font-size:14px;line-height:1.7;color:rgba(251,248,240,.62)">A quiet scan of the last 24 hours.</p>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:24px 0">
            ${[
              ['New reservations', counts.newReservations24h],
              ['Reserved total', counts.reserved],
              ['Pending checkouts', counts.pending],
              ['Expired holds', counts.expired],
              ['Abandoned emails sent', counts.abandonedSent24h],
              ['SMS opt-ins', sms24h]
            ].map(([label, value]) => `
              <div style="border:1px solid rgba(251,248,240,.12);border-radius:12px;padding:14px">
                <div style="font-size:24px;font-weight:700">${value}</div>
                <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(251,248,240,.42);margin-top:4px">${label}</div>
              </div>
            `).join('')}
          </div>
          <h2 style="font-size:18px;margin:28px 0 4px">Fresh movement</h2>
          ${rowHtml(freshRows)}
        </div>
      </div>
    `;

    await sendEmail({
      to: ownerEmail(),
      subject,
      html,
      text: `Daily owner digest: ${counts.newReservations24h} new reservations, ${counts.reserved} reserved total, ${counts.pending} pending checkouts, ${sms24h} SMS opt-ins.`
    });

    return res.status(200).json({ ok: true, sent_to: ownerEmail(), counts: { ...counts, sms24h } });
  } catch (err) {
    console.error('Daily owner digest error:', err);
    return res.status(500).json({ error: 'Could not send daily owner digest.' });
  }
}
