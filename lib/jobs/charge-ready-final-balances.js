// Protected daily job: charges final-balance records after notice wait is complete.

import { autoChargeReadyFinalBalances } from '../final-balance-auto-charge.js';
import { requireAdmin } from '../yogacloak-ops.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const data = await autoChargeReadyFinalBalances({
      dryRun: req.query?.dry_run === 'true' || req.body?.dry_run === true,
      limit: Math.min(Math.max(Number(process.env.FINAL_BALANCE_AUTO_CHARGE_LIMIT || 100) || 100, 1), 100)
    });
    return res.status(data.summary.failed ? 207 : 200).json(data);
  } catch (err) {
    console.error('Daily final-balance auto charge error:', err);
    return res.status(500).json({ error: err.message || 'Could not run final-balance auto charge.' });
  }
}
