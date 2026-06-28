import {
  TABLES,
  airtableRequest,
  contactEmail,
  contactForReservation,
  contactName,
  createRecord,
  escapeFormulaValue,
  getRecord,
  money,
  notesWith,
  parseNotes,
  productLabel,
  sendEmail,
  stripeRequest,
  updateRecord
} from './yogacloak-ops.js';

const BLOCKED_STATUSES = new Set(['Cancelled', 'Cancelled + Refunded', 'Expired', 'Transferred']);

function finalBalanceAmount(fields, notes) {
  const retail = Number(fields['Final Retail Total'] || 0);
  const deposit = Number(fields['Deposit Amount'] || 0);
  return Number(notes.final_balance_total || retail - deposit);
}

function noticeHoursRequired() {
  return Number(process.env.FINAL_BALANCE_NOTICE_HOURS || 24);
}

function alreadyCharged(fields, notes) {
  return Boolean(
    notes.final_balance_payment_intent_id ||
    notes.final_balance_status === 'succeeded' ||
    fields['Final Checkout Status'] === 'Completed' ||
    fields['Reservation Status'] === 'Converted to Order'
  );
}

function readinessForFields(fields) {
  const notes = parseNotes(fields.Notes);
  const amount = finalBalanceAmount(fields, notes);
  const amountCents = Math.round(amount * 100);
  const noticeSentAt = notes.final_balance_notice_sent_at ? Date.parse(notes.final_balance_notice_sent_at) : 0;
  const requiredHours = noticeHoursRequired();
  const noticeAgeHours = noticeSentAt ? (Date.now() - noticeSentAt) / (1000 * 60 * 60) : 0;
  const noticeWaitRemainingHours = noticeSentAt ? Math.max(0, requiredHours - noticeAgeHours) : requiredHours;
  const savedPaymentMethod = Boolean(notes.stripe_customer_id && notes.stripe_payment_method_id);
  const charged = alreadyCharged(fields, notes);
  const status = fields['Reservation Status'] || '';
  const blockedReasons = [];

  if (BLOCKED_STATUSES.has(status)) blockedReasons.push(`Reservation is ${status}.`);
  if (!notes.future_charge_authorized) blockedReasons.push('Missing saved future-charge authorization.');
  if (!savedPaymentMethod) blockedReasons.push('Missing saved Stripe customer or payment method.');
  if (!amountCents || amountCents < 50) blockedReasons.push('Final balance amount is invalid.');

  const blockedReason = blockedReasons.join(' ');
  const blocked = Boolean(blockedReason);
  const noticeRequired = !charged && !blocked && !noticeSentAt;
  const waitingPeriod = !charged && !blocked && noticeSentAt && noticeWaitRemainingHours > 0;
  const chargeEligible = !charged && !blocked && noticeSentAt && noticeWaitRemainingHours <= 0;

  let readinessGroup = 'Blocked';
  if (charged) readinessGroup = 'Already Charged';
  else if (chargeEligible) readinessGroup = 'Ready to Charge';
  else if (waitingPeriod) readinessGroup = 'Waiting Period';
  else if (noticeRequired) readinessGroup = 'Needs Notice';

  return {
    amount,
    amount_cents: amountCents,
    already_charged: charged,
    blocked_reason: charged ? '' : blockedReason,
    charge_eligible: chargeEligible,
    final_balance_notice_sent_at: notes.final_balance_notice_sent_at || '',
    future_charge_authorized: Boolean(notes.future_charge_authorized),
    notice_required: noticeRequired,
    notice_wait_remaining_hours: Number(noticeWaitRemainingHours.toFixed(2)),
    readiness_group: readinessGroup,
    stripe_payment_method_saved: savedPaymentMethod
  };
}

async function findPaymentByTransactionId(transactionId) {
  if (!transactionId) return null;
  const params = new URLSearchParams({
    maxRecords: '1',
    filterByFormula: `{Stripe Transaction ID}='${escapeFormulaValue(transactionId)}'`
  });
  const data = await airtableRequest(`${TABLES.payments}?${params}`);
  return (data.records || [])[0] || null;
}

function emailHtml({ firstName, product, amount }) {
  const hello = firstName ? `${firstName},` : 'Hi,';
  return `
    <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
      <div style="max-width:540px;margin:0 auto">
        <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
        <h1 style="font-size:34px;line-height:1.05;font-weight:500;margin:18px 0 18px">Your first drop reservation is almost ready.</h1>
        <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">${hello}</p>
        <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">We're preparing ${product}. The remaining balance of ${money(amount)} will be charged to your saved payment method before shipment.</p>
        <p style="font-size:13px;line-height:1.7;color:rgba(251,248,240,.56)">If anything needs to change, reply to this email before the charge is processed.</p>
      </div>
    </div>
  `;
}

async function sendFinalBalanceNoticeForReservation(reservationId) {
  const reservation = await getRecord(TABLES.reservations, reservationId);
  const fields = reservation.fields || {};
  const readiness = readinessForFields(fields);
  const notes = parseNotes(fields.Notes);
  const contact = await contactForReservation(fields);
  const email = contactEmail(contact);

  if (!email) throw new Error('Reservation is missing customer email.');
  if (readiness.already_charged) throw new Error('Reservation is already charged.');
  if (readiness.blocked_reason) throw new Error(readiness.blocked_reason);
  if (!readiness.notice_required && readiness.final_balance_notice_sent_at) {
    return {
      ok: true,
      already_sent: true,
      reservation_record_id: reservationId,
      amount: readiness.amount
    };
  }

  const firstName = contactName(contact);
  const product = productLabel(notes, fields);
  const subject = 'Your yogacloak balance before shipment';
  const text = `${firstName ? `${firstName}, ` : ''}we're preparing ${product}. The remaining balance of ${money(readiness.amount)} will be charged to your saved payment method before shipment. Reply if anything needs to change.`;

  await sendEmail({
    to: email,
    subject,
    html: emailHtml({ firstName, product, amount: readiness.amount }),
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

  return { ok: true, reservation_record_id: reservationId, amount: readiness.amount };
}

async function chargeFinalBalanceReservation(reservationId, { overrideNoticeWait = false, dryRun = false } = {}) {
  const reservation = await getRecord(TABLES.reservations, reservationId);
  const fields = reservation.fields || {};
  const notes = parseNotes(fields.Notes);
  const readiness = readinessForFields(fields);

  if (readiness.already_charged) {
    return {
      ok: true,
      result: 'already_charged',
      reservation_record_id: reservationId,
      payment_intent_id: notes.final_balance_payment_intent_id || '',
      status: notes.final_balance_status || 'succeeded'
    };
  }

  if (readiness.blocked_reason) throw new Error(readiness.blocked_reason);
  if (readiness.notice_required) throw new Error('Send final-balance notice before charging.');
  if (readiness.notice_wait_remaining_hours > 0 && !overrideNoticeWait) {
    throw new Error(`Final-balance notice must be at least ${noticeHoursRequired()} hours old before charging.`);
  }

  if (dryRun) {
    return {
      ok: true,
      result: 'dry_run',
      reservation_record_id: reservationId,
      amount: readiness.amount
    };
  }

  const params = new URLSearchParams();
  params.append('amount', String(readiness.amount_cents));
  params.append('currency', 'usd');
  params.append('customer', notes.stripe_customer_id);
  params.append('payment_method', notes.stripe_payment_method_id);
  params.append('off_session', 'true');
  params.append('confirm', 'true');
  params.append('description', 'yogacloak final product balance');
  params.append('metadata[reservation_record_id]', reservationId);
  params.append('metadata[payment_type]', 'final_balance');

  const paymentIntent = await stripeRequest('payment_intents', {
    method: 'POST',
    headers: {
      'Idempotency-Key': `final_balance_${reservationId}_${readiness.amount_cents}`
    },
    body: params
  });

  const paid = paymentIntent.status === 'succeeded';
  const contactId = Array.isArray(fields.Contact) ? fields.Contact[0] : null;
  const existingPayments = Array.isArray(fields.Payment) ? fields.Payment : [];
  const existingPayment = await findPaymentByTransactionId(paymentIntent.id);
  const paymentRecord = existingPayment || await createRecord(TABLES.payments, {
    Contact: contactId ? [contactId] : [],
    Reservation: [reservationId],
    'Payment Date': new Date().toISOString().slice(0, 10),
    Amount: readiness.amount,
    'Payment Type': 'Checkout',
    'Stripe Transaction ID': paymentIntent.id,
    'Stripe Customer ID': notes.stripe_customer_id,
    'Payment Status': paid ? 'Paid' : 'Pending'
  });

  await updateRecord(TABLES.reservations, reservationId, {
    Payment: [...new Set([...existingPayments, paymentRecord.id])],
    'Final Checkout Status': paid ? 'Completed' : 'Sent',
    'Reservation Status': paid ? 'Converted to Order' : fields['Reservation Status'],
    Notes: JSON.stringify({
      ...notes,
      final_balance_payment_intent_id: paymentIntent.id,
      final_balance_charged_at: new Date().toISOString(),
      final_balance_status: paymentIntent.status
    })
  });

  return {
    ok: true,
    result: paid ? 'charged' : 'pending',
    reservation_record_id: reservationId,
    payment_intent_id: paymentIntent.id,
    status: paymentIntent.status,
    amount: readiness.amount
  };
}

export {
  chargeFinalBalanceReservation,
  finalBalanceAmount,
  readinessForFields,
  sendFinalBalanceNoticeForReservation
};
