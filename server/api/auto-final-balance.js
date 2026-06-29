// Protected endpoint: automatically charges final balances whose notice wait is complete.
// POST /api/auto-final-balance

import { auditAdminAction } from '../../lib/admin-audit.js';
import { autoChargeReadyFinalBalances } from '../../lib/final-balance-auto-charge.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 2, windowSeconds: 60, keyPrefix: 'auto-final-balance' })) return;
  if (rejectLargeRequest(req, res, 12 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    const dryRun = req.method === 'GET' || req.body?.dry_run === true;
    const limit = Math.min(Math.max(Number(req.body?.limit || process.env.FINAL_BALANCE_AUTO_CHARGE_LIMIT || 100) || 100, 1), 100);
    const data = await autoChargeReadyFinalBalances({ dryRun, limit });
    await auditAdminAction(req, {
      actionType: dryRun ? 'dry_run_auto_final_balance' : 'auto_charge_final_balance',
      title: dryRun ? 'Admin checked automatic final-balance batch' : 'Admin ran automatic final-balance batch',
      details: `${data.processed} ready reservation(s) processed.`,
      metadata: {
        dry_run: dryRun,
        records_checked: data.records_checked,
        ready_total: data.ready_total,
        processed: data.processed,
        has_more_ready: data.has_more_ready,
        summary: data.summary,
        owner_summary_email: data.owner_summary_email
      }
    });
    return res.status(data.summary.failed ? 207 : 200).json(data);
  } catch (err) {
    console.error('Auto final-balance error:', err);
    return res.status(500).json({ error: err.message || 'Could not run automatic final-balance batch.' });
  }
}
