import { updateInquiryStatus } from '../../lib/communications.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 20, windowSeconds: 60, keyPrefix: 'admin-inquiry-status' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const inquiryId = String(req.body?.inquiry_id || '').trim();
    const status = String(req.body?.status || '').trim();
    if (!inquiryId || !status) return res.status(400).json({ error: 'Inquiry and status are required.' });
    const inquiry = await updateInquiryStatus(inquiryId, status);
    return res.status(200).json({ ok: true, inquiry });
  } catch (err) {
    console.error('Admin update inquiry status error:', err);
    return res.status(400).json({ error: err.message || 'Could not update inquiry.' });
  }
}
