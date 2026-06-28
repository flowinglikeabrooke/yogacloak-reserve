import { loadDashboard } from '../../lib/admin-hub-data.js';
import { requireAdmin } from '../../lib/yogacloak-ops.js';
import { loadSecurityStatus } from '../../lib/security-status.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const dashboard = await loadDashboard();
    return res.status(200).json({ ok: true, ...dashboard, security_status: loadSecurityStatus() });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    return res.status(500).json({ error: 'Could not load dashboard.' });
  }
}
