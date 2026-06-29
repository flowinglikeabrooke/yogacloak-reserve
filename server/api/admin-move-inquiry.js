import { moveInquiryToCustomer } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 12, windowSeconds: 60, keyPrefix: 'admin-move-inquiry' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    const inquiryId = String(req.body?.inquiry_id || '').trim();
    const customerId = String(req.body?.customer_id || '').trim();
    const inquiry = await moveInquiryToCustomer({ inquiryId, customerId });
    await auditAdminAction(req, {
      actionType: 'move_inquiry',
      title: 'Admin moved inquiry to customer',
      customerId,
      details: `Moved inquiry ${inquiryId} to ${customerId}.`,
      metadata: { inquiry_id: inquiryId, customer_id: customerId }
    });
    return res.status(200).json({ ok: true, inquiry });
  } catch (err) {
    console.error('Admin move inquiry error:', err);
    return res.status(400).json({ error: err.message || 'Could not move inquiry.' });
  }
}
