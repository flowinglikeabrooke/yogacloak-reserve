import { loadCustomerDetail } from '../lib/admin-hub-data.js';
import { auditAdminAction } from '../lib/admin-audit.js';
import { sendCustomerSms } from '../lib/communications.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 12, windowSeconds: 60, keyPrefix: 'admin-send-sms' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const body = String(req.body?.body || '').trim().slice(0, 1000);
    if (!customerId || !body) return res.status(400).json({ error: 'Customer and message are required.' });
    const detail = await loadCustomerDetail(customerId);
    if (!detail?.customer) return res.status(404).json({ error: 'Customer not found.' });
    const communication = await sendCustomerSms({ customer: detail.customer, body });
    await auditAdminAction(req, {
      actionType: 'send_sms',
      title: 'Admin sent customer SMS',
      customerId,
      details: body,
      metadata: { communication_id: communication?.id || '' }
    });
    return res.status(200).json({ ok: true, communication });
  } catch (err) {
    console.error('Admin send SMS error:', err);
    return res.status(400).json({ error: err.message || 'Could not send SMS.' });
  }
}
