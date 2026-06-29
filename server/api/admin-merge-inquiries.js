import { mergeInquiries } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 8, windowSeconds: 60, keyPrefix: 'admin-merge-inquiries' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    const sourceInquiryId = String(req.body?.source_inquiry_id || '').trim();
    const targetInquiryId = String(req.body?.target_inquiry_id || '').trim();
    const merged = await mergeInquiries({ sourceInquiryId, targetInquiryId });
    await auditAdminAction(req, {
      actionType: 'merge_inquiries',
      title: 'Admin merged inquiry records',
      customerId: merged?.target?.customer_id || null,
      details: `Merged ${sourceInquiryId} into ${targetInquiryId}.`,
      metadata: { source_inquiry_id: sourceInquiryId, target_inquiry_id: targetInquiryId }
    });
    return res.status(200).json({ ok: true, merged });
  } catch (err) {
    console.error('Admin merge inquiries error:', err);
    return res.status(400).json({ error: err.message || 'Could not merge inquiries.' });
  }
}
