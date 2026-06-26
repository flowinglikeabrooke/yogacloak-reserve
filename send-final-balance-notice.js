// Protected endpoint: emails the customer before charging the final balance.
// POST /api/send-final-balance-notice with x-admin-token.
// Body: { "reservation_record_id": "rec..." }

import {
  TABLES,
  contactEmail,
  contactForReservation,
  contactName,
  getRecord,
  money,
  notesWith,
  parseNotes,
  productLabel,
  requireAdmin,
  sendEmail,
  updateRecord
} from '../lib/yogacloak-ops.js';

function finalBalance(fields, notes) {
  const retail = Number(fields['Final Retail Total'] || 0);
  const deposit = Number(fields['Deposit Amount'] || 0);
  return Number(notes.final_balance_total || retail - deposit);
}

function emailHtml({ firstName, product, amount }) {
  const hello = firstName ? `${firstName},` : 'Hi,';
  return `
    <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
      <div style="max-width:540px;margin:0 auto">
        <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
        <h1 style="font-size:34px;line-height:1.05;font-weight:500;margin:18px 0 18px">Your first drop reservation is almost ready.</h1>
        <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">${hello}</p>
        <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">We’re preparing ${product}. The remaining balance of ${money(amount)} will be charged to your saved payment method before shipment.</p>
        <p style="font-size:13px;line-height:1.7;color:rgba(251,248,240,.56)">If anything needs to change, reply to this email before the charge is processed.</p>
      </div>
    </div>
  `;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const reservationId = String(req.body?.reservation_record_id || '').trim();
    if (!reservationId.startsWith('rec')) {
      return res.status(400).json({ error: 'Missing reservation_record_id' });
    }

    const reservation = await getRecord(TABLES.reservations, reservationId);
    const fields = reservation.fields || {};
    const notes = parseNotes(fields.Notes);
    const contact = await contactForReservation(fields);
    const email = contactEmail(contact);

    if (!email) return res.status(400).json({ error: 'Reservation is missing customer email.' });
    if (!notes.future_charge_authorized) {
      return res.status(400).json({ error: 'Reservation does not have future-charge authorization.' });
    }

    const amount = finalBalance(fields, notes);
    if (!amount || amount < 0.5) return res.status(400).json({ error: 'Final balance amount is invalid.' });

    const firstName = contactName(contact);
    const product = productLabel(notes, fields);
    const subject = 'Your yogacloak balance before shipment';
    const text = `${firstName ? `${firstName}, ` : ''}we're preparing ${product}. The remaining balance of ${money(amount)} will be charged to your saved payment method before shipment. Reply if anything needs to change.`;

    await sendEmail({
      to: email,
      subject,
      html: emailHtml({ firstName, product, amount }),
      text
    });

    await updateRecord(TABLES.reservations, reservationId, {
      'Reservation Status': 'Final Balance Notice Sent',
      'Final Checkout Status': 'Notice Sent',
      Notes: notesWith(fields, {
        final_balance_notice_sent_at: new Date().toISOString(),
        final_balance_notice_subject: subject
      })
    });

    return res.status(200).json({ ok: true, reservation_record_id: reservationId, amount });
  } catch (err) {
    console.error('Final balance notice error:', err);
    return res.status(500).json({ error: 'Could not send final-balance notice.' });
  }
}
