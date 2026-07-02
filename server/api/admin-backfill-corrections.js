// Protected endpoint: audits paid-looking reservations against Stripe and,
// when { "fix": true } is posted, downgrades records Stripe cannot confirm.
//
// POST /api/admin-backfill-corrections
// Body: {} for a report-only audit, { "fix": true } to apply corrections.

import reconcileStripeAirtable from '../../lib/jobs/reconcile-stripe-airtable.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await checkRateLimit(req, res, { maxRequests: 3, windowSeconds: 60, keyPrefix: 'admin-backfill' }))) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireOwner(req, res)) return;

  const fix = req.body?.fix === true;
  req.body = { fix };

  let statusCode = 200;
  let payload = null;
  const proxy = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
    setHeader(name, value) { res.setHeader(name, value); return this; },
    end() { return this; }
  };

  await reconcileStripeAirtable(req, proxy);

  if (fix && payload?.ok) {
    await auditAdminAction(req, {
      actionType: 'backfill_corrections',
      title: 'Admin ran reservation backfill correction',
      details: `Corrected ${(payload.corrections || []).length} reservation(s) that Stripe could not confirm as paid.`,
      metadata: { corrections: (payload.corrections || []).slice(0, 50) }
    });
  }

  return res.status(statusCode).json(payload || { error: 'Backfill audit returned no result.' });
}
