import { databaseEnabled, selectRows } from '../../lib/database.js';
import { requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireOwner(req, res)) return;

  try {
    if (!databaseEnabled()) {
      return res.status(200).json({ ok: true, actions: [], database_enabled: false });
    }

    const limit = Math.min(Number(req.query?.limit || 80), 150);
    const actions = await selectRows('admin_actions', {
      select: 'id,admin_user_id,admin_user_email,admin_user_name,admin_user_role,action_type,title,details,customer_id,reservation_id,metadata,created_at',
      order: 'created_at.desc',
      limit
    });
    return res.status(200).json({ ok: true, actions, database_enabled: true });
  } catch (err) {
    console.error('Admin actions error:', err);
    return res.status(500).json({ error: 'Could not load team activity.' });
  }
}
