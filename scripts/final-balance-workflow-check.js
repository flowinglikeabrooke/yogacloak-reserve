import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function includes(file, text, label = text) {
  assert.ok(read(file).includes(text), `${file} is missing: ${label}`);
}

function notIncludes(file, text, label = text) {
  assert.ok(!read(file).includes(text), `${file} should not include: ${label}`);
}

function functionBody(file, name) {
  const source = read(file);
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${file} is missing function ${name}`);
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

const finalBalance = 'lib/final-balance.js';
const batchEndpoint = 'server/api/batch-final-balance.js';
const noticeEndpoint = 'server/api/send-final-balance-notice.js';
const adminReservations = 'server/api/admin-reservations.js';
const adminHub = 'private/admin-hub.html';
const reserve = 'server/api/reserve.js';
const stripeWebhook = 'server/api/stripe-webhook.js';
const apiDispatcher = 'api/[...path].js';
const noRawCardFiles = [
  finalBalance,
  batchEndpoint,
  noticeEndpoint,
  adminReservations,
  reserve,
  stripeWebhook
];

for (const file of noRawCardFiles) {
  const source = read(file);
  for (const pattern of [
    /card_number/i,
    /cardNumber/,
    /card\[[^\]]*number/i,
    /cvc/i,
    /security_code/i
  ]) {
    assert.ok(!pattern.test(source), `${file} must not handle raw card data: ${pattern}`);
  }
}

includes(reserve, "payment_intent_data[setup_future_usage]", 'Stripe Checkout saves payment method for off-session use');
includes(reserve, "consent_collection[payment_method_reuse_agreement][position]", 'Stripe Checkout shows saved payment method agreement');
includes(reserve, "future_charge_authorized: 'true'", 'Checkout metadata carries future-charge authorization');

includes(stripeWebhook, 'stripe_customer_id: session.customer', 'Stripe customer ID is saved after deposit payment');
includes(stripeWebhook, 'stripe_payment_method_id: savedPaymentMethod', 'Stripe payment method ID is saved after deposit payment');
includes(stripeWebhook, "future_charge_authorized: metadata.future_charge_authorized === 'true'", 'future-charge authorization is saved after deposit payment');

includes(finalBalance, "const BLOCKED_STATUSES = new Set(['Cancelled', 'Cancelled + Refunded', 'Expired', 'Transferred'])", 'blocked statuses are enforced');
includes(finalBalance, '!notes.future_charge_authorized', 'future charge authorization is required');
includes(finalBalance, 'Missing saved Stripe customer or payment method.', 'saved Stripe customer/payment method is required');
includes(finalBalance, 'Send final-balance notice before charging.', 'notice is required before charging');
includes(finalBalance, 'notice_wait_remaining_hours > 0', 'notice waiting period is enforced');
includes(finalBalance, "'Idempotency-Key': `final_balance_${reservationId}`", 'Stripe idempotency key is stable per reservation');
notIncludes(finalBalance, "'Idempotency-Key': `final_balance_${reservationId}_${readiness.amount_cents}`", 'Stripe idempotency key must not change when the amount changes');
includes(finalBalance, 'findPaymentByTransactionId(paymentIntent.id)', 'Airtable payment duplication is checked');
includes(finalBalance, "'Payment Status': paid ? 'Paid' : 'Failed'", 'Airtable payment status matches Stripe success/failure');
includes(finalBalance, "'Final Checkout Status': paid ? 'Completed' : 'Failed'", 'Airtable final checkout status matches Stripe success/failure');
notIncludes(finalBalance, "'Final Checkout Status': paid ? 'Completed' : 'Sent'", 'non-succeeded Stripe final-balance attempts must not look sent');
includes(finalBalance, "'Reservation Status': paid ? 'Converted to Order'", 'Airtable reservation status is updated after successful charge');
includes(finalBalance, 'const attemptedAt = new Date().toISOString();', 'Stripe final-balance attempts use one timestamp per attempt');
includes(finalBalance, 'final_balance_last_attempt_at: attemptedAt', 'Stripe final-balance attempts record last attempt time');
includes(finalBalance, 'final_balance_last_error: stripeStatusReason', 'non-succeeded Stripe final-balance attempts record status reason');
includes(finalBalance, "...(paid ? { final_balance_charged_at: attemptedAt } : {})", 'final-balance charged timestamp is written only after Stripe succeeds');
includes(finalBalance, "'Final Checkout Status': 'Failed'", 'failed Stripe charge attempts are recorded on the reservation');
includes(finalBalance, 'final_balance_last_attempt_at', 'failed final-balance attempt timestamp is recorded');
includes(finalBalance, 'final_balance_last_error', 'failed final-balance attempt reason is recorded');
includes(finalBalance, 'requireLiveFinalChargeEnabled();', 'live final-balance charge brake is enforced');
assert.ok(!functionBody(finalBalance, 'alreadyCharged').includes('final_balance_payment_intent_id'), 'payment intent presence alone must not count as already charged');
assert.ok(functionBody(finalBalance, 'chargeFinalBalanceReservation').includes('amount: readiness.amount'), 'already-charged charge results include final-balance amount for reporting');
includes(finalBalance, 'function escapeHtml(value)', 'final-balance email HTML escaping helper exists');
includes(finalBalance, 'const productText = escapeHtml(product)', 'final-balance notice product text is HTML escaped');
includes(finalBalance, 'const amountText = escapeHtml(money(amount))', 'final-balance notice amount text is HTML escaped');

includes(batchEndpoint, 'chargeFinalBalanceReservation(reservationId, { dryRun })', 'batch endpoint reuses shared charge logic');
includes(apiDispatcher, "'batch-final-balance': batchFinalBalance", 'API dispatcher preserves /api/batch-final-balance public route');
includes(apiDispatcher, 'bodyParser: false', 'API dispatcher preserves raw-body support for Stripe webhooks');
includes(apiDispatcher, "name === 'stripe-webhook'", 'API dispatcher does not pre-parse Stripe webhook raw body');
notIncludes(batchEndpoint, "stripeRequest('payment_intents'", 'batch endpoint must not duplicate Stripe charge logic');
includes(batchEndpoint, 'requireAdmin(req, res)', 'batch endpoint requires admin authorization');
includes(batchEndpoint, "const unsafe = isUnsafeSkip(message)", 'unsafe records are identified before reporting');
notIncludes(batchEndpoint, "const unsafe = dryRun || isUnsafeSkip(message)", 'dry runs must not hide true backend failures as skipped records');
includes(batchEndpoint, "status: unsafe ? 'skipped' : 'failed'", 'unsafe records are skipped instead of treated as charged');
includes(batchEndpoint, "status === 'already_charged'", 'already charged records are reported separately');
includes(batchEndpoint, 'Already charged; no new charge created.', 'already-charged batch result explains no new charge happened');
includes(batchEndpoint, 'reason_code: resultReasonCode(result)', 'batch result includes normalized reason code');
includes(batchEndpoint, "reason_code: unsafe ? 'unsafe_skip' : 'charge_failed'", 'batch errors include normalized skip/failure reason code');
includes(batchEndpoint, 'sendOwnerSummary({ dryRun, results })', 'owner summary email is sent after real batch');
includes(batchEndpoint, 'if (dryRun) return;', 'dry runs do not email owner summary or charge');
includes(batchEndpoint, 'owner_summary_email: ownerSummaryEmail', 'batch response reports owner summary email status');
includes(batchEndpoint, 'escapeHtml(summaryRows(results))', 'owner summary result rows are HTML escaped');

includes(noticeEndpoint, 'sendFinalBalanceNoticeForReservation(reservationId)', 'notice endpoint reuses shared notice logic');

for (const field of [
  'charge_eligible',
  'notice_required',
  'notice_status',
  'notice_wait_remaining_hours',
  'blocked_reason',
  'stripe_payment_method_saved',
  'already_charged'
]) {
  includes(adminReservations, field, `admin reservations exposes ${field}`);
}
includes(adminReservations, 'final_balance_status', 'admin reservations exposes final-balance Stripe status');
includes(adminReservations, 'final_balance_last_attempt_at', 'admin reservations exposes last final-balance attempt time');
includes(adminReservations, 'final_balance_last_error', 'admin reservations exposes last final-balance error');
includes(adminReservations, 'final_balance_safety', 'admin reservations exposes final-balance safety status');
includes(adminReservations, 'final_balance_summary', 'admin reservations exposes final-balance summary totals');
includes(adminReservations, 'ready_to_charge_amount', 'admin reservations exposes ready-to-charge amount');
includes(adminReservations, 'notice_hours', 'final-balance safety status exposes notice wait hours');
includes(adminReservations, 'allow_live_final_charges', 'final-balance safety status exposes live-charge lock');
includes(adminReservations, "'Cancelled + Refunded'", 'admin reservations includes refunded cancellations in blocked readiness view');
includes(adminReservations, 'record_limit', 'admin reservations reports the load limit');
includes(adminReservations, 'has_more: records.length > limit', 'admin reservations reports when more records exist than were loaded');
notIncludes(adminReservations, 'stripe_customer_id: notes.stripe_customer_id', 'admin reservations should not expose saved Stripe customer IDs to the browser');
notIncludes(adminReservations, 'stripe_payment_method_id: notes.stripe_payment_method_id', 'admin reservations should not expose saved Stripe payment method IDs to the browser');

for (const group of ['Needs Notice', 'Waiting Period', 'Ready to Charge', 'Already Charged', 'Blocked']) {
  includes(adminHub, group, `admin final-balance UI includes ${group}`);
}

includes(adminHub, 'sendNotices', 'admin can send notices for selected reservations');
includes(adminHub, 'selectNeedsNotice', 'admin can select notice-needed reservations');
includes(adminHub, 'Select needs notice', 'admin exposes select needs notice action');
includes(adminHub, 'noticeResultReport()', 'admin renders per-reservation notice results');
includes(adminHub, 'Notice send results', 'admin labels notice result report');
includes(adminHub, "['Reservation','Status','Final balance','Reason']", 'admin notice result table shows reservation status, balance, and reason');
includes(adminHub, '/api/batch-final-balance', 'admin can run batch final-balance endpoint');
includes(adminHub, 'Dry run', 'admin exposes dry run action');
includes(adminHub, 'Charge ready batch', 'admin exposes real batch charge action');
includes(adminHub, 'Ready amount', 'admin final-balance summary shows ready-to-charge amount');
includes(adminHub, 'reservationLoadNotice()', 'admin shows reservation load/cap status');
includes(adminHub, 'Showing ', 'admin warns when more reservation records exist than are loaded');
includes(adminHub, 'window.confirm(message)', 'admin asks for confirmation before real batch charge');
includes(adminHub, 'readyAmount', 'admin calculates selected ready-to-charge total before confirmation');
includes(adminHub, "totaling '+money(readyAmount)+'", 'admin confirmation shows the batch charge total');
includes(adminHub, 'Batch charge cancelled.', 'admin reports cancelled real batch charge');
includes(adminHub, 'No selected reservations are ready to charge.', 'admin blocks real batch when no selected reservation is ready');
includes(adminHub, 'Batch limit is 100 reservations. Select fewer records and try again.', 'admin blocks oversized final-balance batch requests before sending');
includes(adminHub, 'batchBusy', 'admin tracks in-progress batch requests');
includes(adminHub, 'Batch request already running.', 'admin blocks duplicate in-progress batch requests');
includes(adminHub, 'Charge eligible', 'admin rows show eligibility');
includes(adminHub, 'notice_status', 'admin rows show notice status');
includes(adminHub, 'final_balance_last_attempt_at', 'admin rows show last final-balance attempt time');
includes(adminHub, 'final_balance_last_error', 'admin rows show last final-balance error');
includes(adminHub, 'Saved card', 'admin rows show saved Stripe payment method status');
includes(adminHub, 'blocked_reason', 'admin rows show blocked reason');
includes(adminHub, 'batchResultReport()', 'admin renders per-reservation batch results');
includes(adminHub, 'Batch charge results', 'admin labels real batch result report');
includes(adminHub, 'Dry run results', 'admin labels dry-run result report');
includes(adminHub, 'Owner email', 'admin batch report shows owner summary email status');
includes(adminHub, 'Owner summary email failed:', 'admin batch report shows owner summary email failure');
includes(adminHub, "['Reservation','Status','Code','Amount','Stripe status','Payment intent','Reason']", 'admin result table shows reservation status, reason code, Stripe status, payment intent, and reason');
includes(adminHub, 'finalBalanceSafetyPanel()', 'admin renders charging safety panel');
includes(adminHub, 'Charging safety', 'admin labels charging safety panel');
includes(adminHub, 'Live final charges', 'admin shows live final charge lock state');
includes(adminHub, 'Notice wait', 'admin shows configured notice wait');
includes(adminHub, 'Run one Stripe test-mode reservation end to end before enabling live final charges.', 'admin reminds owner to test before live use');

console.log('Final-balance workflow check passed.');
