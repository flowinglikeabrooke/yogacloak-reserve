import { clearCsrfCookie, clearSessionCookie } from '../../lib/admin-auth.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  await auditAdminAction(req, { actionType: 'admin_logout', title: 'Admin logged out' });
  res.setHeader('Set-Cookie', [clearSessionCookie(), clearCsrfCookie()]);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}
