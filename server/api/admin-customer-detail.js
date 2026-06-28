import { loadCustomerDetail } from '../../lib/admin-hub-data.js';
import { requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.query?.id || '').trim();
    if (!customerId) return res.status(400).json({ error: 'Missing customer id.' });
    const detail = await loadCustomerDetail(customerId);
    if (!detail) return res.status(404).json({ error: 'Customer not found.' });
    return res.status(200).json({ ok: true, ...detail });
  } catch (err) {
    console.error('Admin customer detail error:', err);
    return res.status(500).json({ error: 'Could not load customer detail.' });
  }
}
