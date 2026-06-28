import { hasAdminSession } from '../../lib/admin-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, authenticated: hasAdminSession(req) });
}
