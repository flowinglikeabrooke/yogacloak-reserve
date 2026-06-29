import { archiveInquiry } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireFounder } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 12, windowSeconds: 60, keyPrefix: 'admin-delete-inquiry' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireFounder(req, res)) return;

  try {
    const inquiryId = String(req.body?.inquiry_id || '').trim();
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    if (!inquiryId) return res.status(400).json({ error: 'Missing inquiry id.' });

    const inquiry = await archiveInquiry({ inquiryId, reason });
    await auditAdminAction(req, {
      actionType: 'archive_inquiry',
      title: 'Admin archived inquiry',
      customerId: inquiry?.customer_id || null,
      details: reason || `Archived inquiry ${inquiryId} from active CRM.`,
      metadata: { inquiry_id: inquiryId }
    });
    return res.status(200).json({ ok: true, inquiry });
  } catch (err) {
    console.error('Admin archive inquiry error:', err);
    return res.status(400).json({ error: err.message || 'Could not archive inquiry.' });
  }
}
