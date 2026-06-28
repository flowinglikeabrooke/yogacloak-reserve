import { clearCsrfCookie, clearSessionCookie } from '../lib/admin-auth.js';
import { auditAdminAction } from '../lib/admin-audit.js';

export default async function handler(req, res) {
  if (!['POST', 'GET'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  await auditAdminAction(req, { actionType: 'admin_logout', title: 'Admin logged out' });
  res.setHeader('Set-Cookie', [clearSessionCookie(), clearCsrfCookie()]);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}
