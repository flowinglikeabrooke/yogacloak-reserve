import { auditAdminAction } from '../../lib/admin-audit.js';
import { adminUserForEmail, createAdminSession, createCsrfToken, csrfCookie, sessionCookie } from '../../lib/admin-auth.js';
import { checkRateLimit, rejectLargeRequest } from '../../lib/yogacloak-ops.js';

async function verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_ADMIN_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    const error = new Error('Google login is not configured yet.');
    error.statusCode = 503;
    throw error;
  }

  const token = String(credential || '').trim();
  if (!token) {
    const error = new Error('Missing Google login token.');
    error.statusCode = 400;
    throw error;
  }

  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Google could not verify this login.');
    error.statusCode = 401;
    throw error;
  }

  if (payload.aud !== clientId) {
    const error = new Error('Google login was created for a different app.');
    error.statusCode = 401;
    throw error;
  }

  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    const error = new Error('Google email is not verified.');
    error.statusCode = 403;
    throw error;
  }

  return {
    email: String(payload.email || '').trim().toLowerCase(),
    name: String(payload.name || payload.given_name || '').trim()
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 10, windowSeconds: 300, keyPrefix: 'admin-google-login' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;

  try {
    const googleUser = await verifyGoogleCredential(req.body?.credential);
    const adminUser = adminUserForEmail(googleUser.email);
    if (!adminUser) {
      await auditAdminAction(req, {
        actionType: 'admin_login_blocked',
        title: 'Google login blocked',
        metadata: { email: googleUser.email }
      });
      return res.status(403).json({ error: 'That Google email is not approved for yogacloak admin.' });
    }

    const sessionUser = {
      ...adminUser,
      name: adminUser.name || googleUser.name || adminUser.email
    };
    req.adminUser = sessionUser;
    const csrf = createCsrfToken();
    res.setHeader('Set-Cookie', [sessionCookie(createAdminSession(sessionUser)), csrfCookie(csrf)]);
    res.setHeader('Cache-Control', 'no-store');
    await auditAdminAction(req, {
      actionType: 'admin_login_google',
      title: `${sessionUser.name} logged in with Google`,
      metadata: { role: sessionUser.role, email: sessionUser.email }
    });
    return res.status(200).json({ ok: true, csrf_token: csrf, user: sessionUser });
  } catch (err) {
    console.warn('Google admin login failed:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.message || 'Google login failed.' });
  }
}
