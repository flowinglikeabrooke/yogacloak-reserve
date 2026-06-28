import { mergeCustomers } from '../lib/admin-hub-data.js';
import { auditAdminAction } from '../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'admin-merge' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const sourceCustomerId = String(req.body?.source_customer_id || '').trim();
    const targetCustomerId = String(req.body?.target_customer_id || '').trim();
    const merged = await mergeCustomers({ sourceCustomerId, targetCustomerId });
    await auditAdminAction(req, {
      actionType: 'merge_customer',
      title: 'Admin merged customer records',
      customerId: targetCustomerId,
      details: `Merged ${sourceCustomerId} into ${targetCustomerId}.`,
      metadata: { source_customer_id: sourceCustomerId, target_customer_id: targetCustomerId }
    });
    return res.status(200).json({ ok: true, merged });
  } catch (err) {
    console.error('Admin merge customer error:', err);
    return res.status(400).json({ error: err.message || 'Could not merge customers.' });
  }
}
