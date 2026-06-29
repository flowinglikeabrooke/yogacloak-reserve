import { updateCustomerProfile } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await checkRateLimit(req, res, { maxRequests: 20, windowSeconds: 60, keyPrefix: 'admin-customer-profile' }))) return;
  if (rejectLargeRequest(req, res, 12 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const fullName = String(req.body?.full_name || '').trim().slice(0, 240);
    const email = String(req.body?.email || '').trim().slice(0, 240);
    const phone = String(req.body?.phone || '').trim().slice(0, 80);
    const status = String(req.body?.status || 'lead').trim().slice(0, 80);
    const birthday = String(req.body?.birthday || '').trim().slice(0, 20);
    const birthdayDiscountCode = String(req.body?.birthday_discount_code || '').trim().slice(0, 120);
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags
      : String(req.body?.tags || '').split(',');

    if (!customerId) return res.status(400).json({ error: 'Missing customer id.' });

    const customer = await updateCustomerProfile({ customerId, fullName, email, phone, status, tags, birthday, birthdayDiscountCode });
    await auditAdminAction(req, {
      actionType: 'update_customer_profile',
      title: 'Admin updated customer profile',
      customerId,
      details: fullName || email || phone || customerId,
      metadata: { status, tags, birthday: birthday || null, birthday_discount_code: birthdayDiscountCode || null }
    });
    return res.status(200).json({ ok: true, customer });
  } catch (err) {
    console.error('Admin customer profile error:', err);
    return res.status(400).json({ error: err.message || 'Could not update customer profile.' });
  }
}
