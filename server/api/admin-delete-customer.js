import { archiveCustomer } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 8, windowSeconds: 60, keyPrefix: 'admin-delete-customer' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    if (!customerId) return res.status(400).json({ error: 'Missing customer id.' });

    const archived = await archiveCustomer({ customerId, reason });
    await auditAdminAction(req, {
      actionType: 'archive_customer',
      title: 'Admin archived customer',
      customerId: String(customerId).startsWith('airtable:') ? null : customerId,
      details: reason || `Archived ${customerId} from active CRM.`,
      metadata: { customer_id: customerId, mode: archived.mode }
    });
    return res.status(200).json({ ok: true, archived });
  } catch (err) {
    console.error('Admin archive customer error:', err);
    return res.status(400).json({ error: err.message || 'Could not archive customer.' });
  }
}
