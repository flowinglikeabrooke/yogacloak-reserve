import { loadCustomerDetail } from '../lib/admin-hub-data.js';
import { auditAdminAction } from '../lib/admin-audit.js';
import { sendCustomerEmail } from '../lib/communications.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 10, windowSeconds: 60, keyPrefix: 'admin-send-email' })) return;
  if (rejectLargeRequest(req, res, 16 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const subject = String(req.body?.subject || '').trim().slice(0, 240);
    const body = String(req.body?.body || '').trim().slice(0, 5000);
    if (!customerId || !subject || !body) return res.status(400).json({ error: 'Customer, subject, and message are required.' });
    const detail = await loadCustomerDetail(customerId);
    if (!detail?.customer) return res.status(404).json({ error: 'Customer not found.' });
    const communication = await sendCustomerEmail({ customer: detail.customer, subject, body });
    await auditAdminAction(req, {
      actionType: 'send_email',
      title: 'Admin sent customer email',
      customerId,
      details: subject,
      metadata: { communication_id: communication?.id || '' }
    });
    return res.status(200).json({ ok: true, communication });
  } catch (err) {
    console.error('Admin send email error:', err);
    return res.status(400).json({ error: err.message || 'Could not send email.' });
  }
}
