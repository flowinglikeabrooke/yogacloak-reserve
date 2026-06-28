import { loadAccounting } from '../../lib/admin-hub-data.js';
import { requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const accounting = await loadAccounting();
    return res.status(200).json({ ok: true, ...accounting });
  } catch (err) {
    console.error('Admin accounting error:', err);
    return res.status(500).json({ error: 'Could not load accounting.' });
  }
}
