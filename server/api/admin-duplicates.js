import { loadDuplicates } from '../../lib/admin-hub-data.js';
import { requireFounder } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireFounder(req, res)) return;

  try {
    const duplicates = await loadDuplicates();
    return res.status(200).json({ ok: true, duplicates });
  } catch (err) {
    console.error('Admin duplicates error:', err);
    return res.status(500).json({ error: 'Could not load duplicates.' });
  }
}
