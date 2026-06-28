import { checkRateLimit, rejectLargeRequest } from '../../lib/yogacloak-ops.js';
import { createAdminSession, createCsrfToken, csrfCookie, sessionCookie, validAdminToken } from '../../lib/admin-auth.js';
import { auditAdminAction } from '../../lib/admin-audit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 6, windowSeconds: 300, keyPrefix: 'admin-login' })) return;
  if (rejectLargeRequest(req, res, 4 * 1024)) return;

  const token = String(req.body?.token || '').trim();
  if (!validAdminToken(token)) {
    return res.status(401).json({ error: 'Invalid admin token.' });
  }

  const csrf = createCsrfToken();
  res.setHeader('Set-Cookie', [sessionCookie(createAdminSession()), csrfCookie(csrf)]);
  res.setHeader('Cache-Control', 'no-store');
  await auditAdminAction(req, { actionType: 'admin_login', title: 'Admin logged in' });
  return res.status(200).json({ ok: true, csrf_token: csrf });
}
