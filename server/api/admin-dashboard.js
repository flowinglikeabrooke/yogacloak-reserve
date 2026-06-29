import { loadDashboard } from '../../lib/admin-hub-data.js';
import { requireAdmin } from '../../lib/yogacloak-ops.js';
import { loadSecurityStatus } from '../../lib/security-status.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const dashboard = await loadDashboard();
    if (req.adminUser?.role !== 'owner' && dashboard?.summary) {
      dashboard.summary.reservations = 0;
      dashboard.summary.needs_notice = 0;
      dashboard.summary.ready_to_charge = 0;
      dashboard.summary.failed_payments = 0;
      dashboard.summary.pending_checkouts = 0;
      dashboard.summary.deposits_collected = 0;
      dashboard.summary.final_balances_collected = 0;
      dashboard.tasks = (dashboard.tasks || []).filter((task) => !['notice', 'charge', 'payment'].includes(task.type));
      dashboard.recent_events = (dashboard.recent_events || []).filter((event) => !['payment_recorded', 'reservation_updated'].includes(event.event_type));
    }
    return res.status(200).json({ ok: true, ...dashboard, admin_user: req.adminUser || null, security_status: loadSecurityStatus() });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    return res.status(500).json({ error: 'Could not load dashboard.' });
  }
}
