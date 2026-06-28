import { updateCustomerNote } from '../lib/admin-hub-data.js';
import { requireAdmin } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!customerId) return res.status(400).json({ error: 'Missing customer id.' });
    const customer = await updateCustomerNote(customerId, note);
    return res.status(200).json({ ok: true, customer });
  } catch (err) {
    console.error('Admin update note error:', err);
    return res.status(400).json({ error: err.message || 'Could not update note.' });
  }
}
