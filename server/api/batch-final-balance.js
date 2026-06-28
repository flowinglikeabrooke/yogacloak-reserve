// Protected endpoint: batch charge ready final balances.
// POST /api/batch-final-balance with x-admin-token.
// Body: { "reservation_record_ids": ["rec..."], "dry_run": false }

import { chargeFinalBalanceReservation, escapeHtml } from '../../lib/final-balance.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin, sendEmail } from '../../lib/yogacloak-ops.js';

function ownerEmail() {
  return process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_TO || 'hello@yogacloak.com';
}

function uniqueReservationIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || '').trim()).filter((id) => id.startsWith('rec')))];
}

function resultStatus(result) {
  if (result.result === 'already_charged') return 'already_charged';
  if (result.result === 'charged') return 'charged';
  if (result.result === 'dry_run') return 'skipped';
  return 'failed';
}

function resultReasonCode(result) {
  if (result.result === 'already_charged') return 'already_charged';
  if (result.result === 'charged') return 'charged';
  if (result.result === 'dry_run') return 'dry_run_ready';
  return 'stripe_status_not_succeeded';
}

function isUnsafeSkip(errorMessage = '') {
  return [
    'Reservation is ',
    'Missing saved future-charge authorization.',
    'Missing saved Stripe customer or payment method.',
    'Final balance amount is invalid.',
    'Send final-balance notice before charging.',
    'Final-balance notice must be at least'
  ].some((message) => errorMessage.includes(message));
}

function summaryRows(results) {
  return results.map((result) => {
    const status = result.status || result.result || 'unknown';
    const amount = result.amount ? `$${Number(result.amount).toFixed(2)}` : '';
    const code = result.reason_code ? `[${result.reason_code}]` : '';
    const reason = result.reason || result.error || '';
    return `${result.reservation_record_id}: ${status} ${amount} ${code} ${reason}`.trim();
  }).join('\n');
}

async function sendOwnerSummary({ dryRun, results }) {
  if (dryRun) return;
  const charged = results.filter((result) => result.status === 'charged').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const already = results.filter((result) => result.status === 'already_charged').length;
  const subject = `yogacloak final-balance batch: ${charged} charged, ${failed} failed`;
  const text = [
    `Batch final-balance summary`,
    `Charged: ${charged}`,
    `Failed: ${failed}`,
    `Skipped: ${skipped}`,
    `Already charged: ${already}`,
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
          <h1 style="font-size:32px;line-height:1.05;font-weight:500;margin:18px 0">Final-balance batch finished.</h1>
          <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">Charged: ${charged}. Failed: ${failed}. Skipped: ${skipped}. Already charged: ${already}.</p>
          <pre style="white-space:pre-wrap;background:#151618;border:1px solid rgba(251,248,240,.12);border-radius:12px;padding:14px;color:rgba(251,248,240,.72);font-size:12px">${escapeHtml(summaryRows(results))}</pre>
        </div>
      </div>
    `
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 3, windowSeconds: 60, keyPrefix: 'money-batch' })) return;
  if (rejectLargeRequest(req, res, 32 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  const reservationIds = uniqueReservationIds(req.body?.reservation_record_ids);
  const dryRun = req.body?.dry_run === true;

  if (!reservationIds.length) {
    return res.status(400).json({ error: 'Provide reservation_record_ids.' });
  }
  if (reservationIds.length > 100) {
    return res.status(400).json({ error: 'Batch limit is 100 reservations.' });
  }

  const results = [];

  for (const reservationId of reservationIds) {
    try {
      const result = await chargeFinalBalanceReservation(reservationId, { dryRun });
      results.push({
        reservation_record_id: reservationId,
        status: resultStatus(result),
        reason_code: resultReasonCode(result),
        amount: result.amount || null,
        payment_intent_id: result.payment_intent_id || '',
        stripe_status: result.status || '',
        reason: result.result === 'dry_run'
          ? 'Dry run: eligible to charge.'
          : result.result === 'already_charged'
            ? 'Already charged; no new charge created.'
          : result.result && !['charged', 'already_charged'].includes(result.result)
            ? `Stripe status: ${result.status || result.result}`
            : ''
      });
    } catch (err) {
      const message = err.message || 'Could not charge final balance.';
      const unsafe = isUnsafeSkip(message);
      results.push({
        reservation_record_id: reservationId,
        status: unsafe ? 'skipped' : 'failed',
        reason_code: unsafe ? 'unsafe_skip' : 'charge_failed',
        reason: message
      });
    }
  }

  const ownerSummaryEmail = {
    skipped: dryRun,
    sent: false,
    error: ''
  };

  try {
    if (!dryRun) {
      await sendOwnerSummary({ dryRun, results });
      ownerSummaryEmail.sent = true;
    }
  } catch (err) {
    console.error('Could not send final-balance batch summary:', err);
    ownerSummaryEmail.error = String(err.message || 'Could not send owner summary email.').slice(0, 500);
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  const charged = results.filter((result) => result.status === 'charged').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const alreadyCharged = results.filter((result) => result.status === 'already_charged').length;

  await auditAdminAction(req, {
    actionType: dryRun ? 'dry_run_final_balance_batch' : 'charge_final_balance_batch',
    title: dryRun ? 'Admin ran final-balance dry run' : 'Admin charged final-balance batch',
    details: `${reservationIds.length} selected reservation(s).`,
    metadata: { reservation_ids: reservationIds, summary: { charged, skipped, failed, already_charged: alreadyCharged }, owner_summary_email: ownerSummaryEmail }
  });

  return res.status(failed ? 207 : 200).json({
    ok: failed === 0,
    dry_run: dryRun,
    owner_summary_email: ownerSummaryEmail,
    summary: { charged, skipped, failed, already_charged: alreadyCharged },
    results
  });
}
