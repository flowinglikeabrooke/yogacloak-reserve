// Protected endpoint: sends tasteful abandoned-reservation reminders.
// POST /api/send-abandoned-reservations with x-admin-token.

import {
  TABLES,
  contactEmail,
  contactForReservation,
  contactName,
  listRecords,
  money,
  notesWith,
  parseNotes,
  productLabel,
  requireAdmin,
  sendEmail,
  updateRecord
} from '../yogacloak-ops.js';

const MIN_AGE_MS = Number(process.env.ABANDONED_EMAIL_DELAY_MINUTES || 45) * 60 * 1000;
const MAX_AGE_MS = Number(process.env.ABANDONED_EMAIL_MAX_HOURS || 48) * 60 * 60 * 1000;

function emailHtml({ firstName, product, checkoutUrl, deposit }) {
  const hello = firstName ? `${firstName},` : 'Hi,';
  return `
    <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
      <div style="max-width:520px;margin:0 auto">
        <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
        <h1 style="font-size:34px;line-height:1.05;font-weight:500;margin:18px 0 18px">Forgot something for the walk home?</h1>
        <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">${hello}</p>
        <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">Your reservation for ${product} is still waiting. A ${money(deposit)} deposit holds your spot in the first drop.</p>
        <p style="margin:28px 0"><a href="${checkoutUrl}" style="display:inline-block;background:#fbf8f0;color:#1E2320;text-decoration:none;border-radius:999px;padding:14px 24px;font-size:13px;font-weight:600">Return to checkout</a></p>
        <p style="font-size:12px;line-height:1.6;color:rgba(251,248,240,.48)">If you changed your mind, no need to do anything. Your unpaid hold will release automatically.</p>
      </div>
    </div>
  `;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const now = Date.now();
    const records = await listRecords(TABLES.reservations, new URLSearchParams({
      filterByFormula: "{Reservation Status}='Pending Payment'"
    }));

    const sent = [];
    const skipped = [];

    for (const record of records) {
      const fields = record.fields || {};
      const notes = parseNotes(fields.Notes);
      const startedAt = notes.checkout_started_at ? Date.parse(notes.checkout_started_at) : 0;
      const age = startedAt ? now - startedAt : 0;

      if (!startedAt || age < MIN_AGE_MS || age > MAX_AGE_MS || notes.abandoned_email_sent_at) {
        skipped.push(record.id);
        continue;
      }

      const contact = await contactForReservation(fields);
      const email = contactEmail(contact);
      const checkoutUrl = notes.stripe_checkout_url || `${process.env.SITE_URL || 'https://www.yogacloak.com'}/yogacloak-reserve-page.html`;

      if (!email) {
        skipped.push(record.id);
        continue;
      }

      const deposit = Number(fields['Deposit Amount'] || notes.deposit_total || 0);
      const product = productLabel(notes, fields);
      const firstName = contactName(contact);
      const subject = 'Forgot something for the walk home?';
      const text = `${firstName ? `${firstName}, ` : ''}your reservation for ${product} is still waiting. A ${money(deposit)} deposit holds your spot in the first drop: ${checkoutUrl}`;

      await sendEmail({
        to: email,
        subject,
        html: emailHtml({ firstName, product, checkoutUrl, deposit }),
        text
      });

      await updateRecord(TABLES.reservations, record.id, {
        Notes: notesWith(fields, {
          abandoned_email_sent_at: new Date().toISOString(),
          abandoned_email_subject: subject
        })
      });

      sent.push(record.id);
    }

    return res.status(200).json({ ok: true, sent, skipped });
  } catch (err) {
    console.error('Abandoned reservation email error:', err);
    return res.status(500).json({ error: 'Could not send abandoned reservation emails.' });
  }
}
