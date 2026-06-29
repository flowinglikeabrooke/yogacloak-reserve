import { loadAutomationDashboard } from '../../lib/automations.js';
import { requireFounder } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireFounder(req, res)) return;

  try {
    const data = await loadAutomationDashboard();
    return res.status(200).json({ ok: true, ...data });
  } catch (err) {
    console.error('Admin automations error:', err);
    return res.status(500).json({ error: 'Could not load automations.' });
  }
}
