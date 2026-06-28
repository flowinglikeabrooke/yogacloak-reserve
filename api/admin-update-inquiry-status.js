import { updateInquiryStatus } from '../lib/communications.js';
import { requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
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
