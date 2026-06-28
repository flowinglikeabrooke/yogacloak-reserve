import { loadOwnerTasks, taskStats } from '../../lib/owner-tasks.js';
import { requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const status = String(req.query?.status || 'active');
    const customerId = String(req.query?.customer_id || '').trim();
    const [tasks, stats] = await Promise.all([
      loadOwnerTasks({ status, customerId, limit: 300 }),
      taskStats()
    ]);
    return res.status(200).json({ ok: true, tasks, stats });
  } catch (err) {
    console.error('Admin tasks error:', err);
    return res.status(500).json({ error: 'Could not load tasks.' });
  }
}
