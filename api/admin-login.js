import { checkRateLimit } from '../lib/yogacloak-ops.js';
import { createAdminSession, sessionCookie, validAdminToken } from '../lib/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 6, windowSeconds: 300 })) return;

  const token = String(req.body?.token || '').trim();
  if (!validAdminToken(token)) {
    return res.status(401).json({ error: 'Invalid admin token.' });
  }

  res.setHeader('Set-Cookie', sessionCookie(createAdminSession()));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}
