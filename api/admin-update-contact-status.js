import { updateContactStatus } from '../lib/admin-hub-data.js';
import { auditAdminAction } from '../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 20, windowSeconds: 60, keyPrefix: 'admin-contact-status' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const contactStatus = String(req.body?.contact_status || '').trim().slice(0, 80);
    const nextFollowUpAt = String(req.body?.next_follow_up_at || '').trim();
    if (!customerId || !contactStatus) return res.status(400).json({ error: 'Customer and contact status are required.' });
    const customer = await updateContactStatus({ customerId, contactStatus, nextFollowUpAt });
    await auditAdminAction(req, {
      actionType: 'update_contact_status',
      title: 'Admin updated contact status',
      customerId,
      details: contactStatus,
      metadata: { next_follow_up_at: nextFollowUpAt }
    });
    return res.status(200).json({ ok: true, customer });
  } catch (err) {
    console.error('Admin contact status error:', err);
    return res.status(400).json({ error: err.message || 'Could not update contact status.' });
  }
}
