import {
  ACTIVE_RESERVATION_STATUSES,
  TABLES,
  listRecords,
  sendEmail,
  statusFormula
} from './yogacloak-ops.js';
import { chargeFinalBalanceReservation, escapeHtml, readinessForFields } from './final-balance.js';
import { notificationEmailsFor } from './admin-notifications.js';

function ownerEmail() {
  return notificationEmailsFor('owners');
}

function skipReasonCode(errorMessage = '') {
  if (errorMessage.includes('Reservation is ')) return 'blocked_status';
  if (errorMessage.includes('Missing saved future-charge authorization.')) return 'missing_future_charge_authorization';
  if (errorMessage.includes('Missing saved Stripe customer or payment method.')) return 'missing_payment_method';
  if (errorMessage.includes('Final balance amount is invalid.')) return 'invalid_final_balance_amount';
  if (errorMessage.includes('Send final-balance notice before charging.')) return 'notice_required';
  if (errorMessage.includes('Final-balance notice must be at least')) return 'waiting_period';
  if (errorMessage.includes('Live final-balance charges are disabled.')) return 'live_charges_disabled';
  return '';
}

function normalizeResult(result) {
  if (result.result === 'already_charged') {
    return {
      reservation_record_id: result.reservation_record_id,
      status: 'already_charged',
      reason_code: 'already_charged',
      amount: result.amount || null,
      payment_intent_id: result.payment_intent_id || '',
      stripe_status: result.status || '',
      reason: 'Already charged; no new charge created.'
    };
  }
  if (result.result === 'dry_run') {
    return {
      reservation_record_id: result.reservation_record_id,
      status: 'skipped',
      reason_code: 'dry_run_ready',
      amount: result.amount || null,
      payment_intent_id: '',
      stripe_status: '',
      reason: 'Dry run: eligible to charge.'
    };
  }
  return {
    reservation_record_id: result.reservation_record_id,
    status: result.result === 'charged' ? 'charged' : 'failed',
    reason_code: result.result === 'charged' ? 'charged' : 'stripe_status_not_succeeded',
    amount: result.amount || null,
    payment_intent_id: result.payment_intent_id || '',
    stripe_status: result.status || '',
    reason: result.result === 'charged' ? '' : `Stripe status: ${result.status || result.result}`
  };
}

function summarize(results) {
  return {
    charged: results.filter((result) => result.status === 'charged').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    already_charged: results.filter((result) => result.status === 'already_charged').length
  };
}

function summaryRows(results) {
  return results.map((result) => {
    const amount = result.amount ? `$${Number(result.amount).toFixed(2)}` : '';
    const code = result.reason_code ? `[${result.reason_code}]` : '';
    return `${result.reservation_record_id}: ${result.status} ${amount} ${code} ${result.reason || ''}`.trim();
  }).join('\n');
}

async function sendOwnerSummary({ dryRun, results, candidateCount }) {
  if (dryRun) return { skipped: true, sent: false, error: '' };
  const summary = summarize(results);
  const subject = `yogacloak auto final-balance batch: ${summary.charged} charged, ${summary.failed} failed`;
  const text = [
    'Automatic final-balance batch summary',
    `Ready candidates: ${candidateCount}`,
    `Charged: ${summary.charged}`,
    `Failed: ${summary.failed}`,
    `Skipped: ${summary.skipped}`,
    `Already charged: ${summary.already_charged}`,
    '',
    summaryRows(results)
  ].join('\n');

  await sendEmail({
    to: ownerEmail(),
    subject,
    text,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
        <div style="max-width:680px;margin:0 auto">
          <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
          <h1 style="font-size:32px;line-height:1.05;font-weight:500;margin:18px 0">Automatic final-balance batch finished.</h1>
          <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">Charged: ${summary.charged}. Failed: ${summary.failed}. Skipped: ${summary.skipped}. Already charged: ${summary.already_charged}.</p>
          <pre style="white-space:pre-wrap;background:#151618;border:1px solid rgba(251,248,240,.12);border-radius:12px;padding:14px;color:rgba(251,248,240,.72);font-size:12px">${escapeHtml(summaryRows(results))}</pre>
        </div>
      </div>
    `
  });
  return { skipped: false, sent: true, error: '' };
}

async function readyFinalBalanceReservationIds({ limit = 100 } = {}) {
  const statuses = [...ACTIVE_RESERVATION_STATUSES, 'Final Balance Notice Sent'];
  const records = await listRecords(TABLES.reservations, new URLSearchParams({
    filterByFormula: statusFormula(statuses)
  }));
  const ready = [];
  for (const record of records) {
    const fields = record.fields || {};
    const readiness = readinessForFields(fields);
    if (readiness.charge_eligible && !readiness.already_charged) {
      ready.push({ id: record.id, amount: readiness.amount });
    }
  }
  return {
    records_checked: records.length,
    ready: ready.slice(0, limit),
    has_more_ready: ready.length > limit,
    ready_total: ready.length
  };
}

async function autoChargeReadyFinalBalances({ dryRun = false, limit = Number(process.env.FINAL_BALANCE_AUTO_CHARGE_LIMIT || 100) || 100 } = {}) {
  const scan = await readyFinalBalanceReservationIds({ limit });
  const results = [];

  for (const item of scan.ready) {
    try {
      const result = await chargeFinalBalanceReservation(item.id, { dryRun });
      results.push(normalizeResult(result));
    } catch (err) {
      const message = err.message || 'Could not charge final balance.';
      const code = skipReasonCode(message);
      results.push({
        reservation_record_id: item.id,
        status: code ? 'skipped' : 'failed',
        reason_code: code || 'charge_failed',
        amount: item.amount || null,
        payment_intent_id: '',
        stripe_status: '',
        reason: message
      });
    }
  }

  let ownerSummaryEmail = { skipped: dryRun, sent: false, error: '' };
  try {
    ownerSummaryEmail = await sendOwnerSummary({ dryRun, results, candidateCount: scan.ready_total });
  } catch (err) {
    ownerSummaryEmail = { skipped: false, sent: false, error: String(err.message || 'Could not send owner summary email.').slice(0, 500) };
  }

  return {
    ok: results.every((result) => result.status !== 'failed'),
    dry_run: dryRun,
    records_checked: scan.records_checked,
    ready_total: scan.ready_total,
    processed: results.length,
    has_more_ready: scan.has_more_ready,
    owner_summary_email: ownerSummaryEmail,
    summary: summarize(results),
    results
  };
}

export {
  autoChargeReadyFinalBalances,
  readyFinalBalanceReservationIds
};
