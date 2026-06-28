import { loadCustomers } from '../../lib/admin-hub-data.js';
import { requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const search = String(req.query?.search || '');
    const contactStatus = String(req.query?.contact_status || '');
    const customers = await loadCustomers({ search, contactStatus });
    return res.status(200).json({ ok: true, customers });
  } catch (err) {
    console.error('Admin customers error:', err);
    return res.status(500).json({ error: 'Could not load customers.' });
  }
}
