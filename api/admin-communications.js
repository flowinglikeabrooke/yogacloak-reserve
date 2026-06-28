import { loadCommunications } from '../lib/communications.js';
import { requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const data = await loadCommunications();
    return res.status(200).json({ ok: true, ...data });
  } catch (err) {
    console.error('Admin communications error:', err);
    return res.status(500).json({ error: 'Could not load communications.' });
  }
}
