import crypto from 'crypto';

const ADMIN_COOKIE = 'yc_admin_session';
const CSRF_COOKIE = 'yc_admin_csrf';
const SESSION_TTL_SECONDS = Number(process.env.ADMIN_SESSION_SECONDS || 60 * 60 * 8);

function adminSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_TOKEN || process.env.FINAL_CHARGE_ADMIN_TOKEN || '';
}

function allowedAdminTokens() {
  return [
    process.env.ADMIN_TOKEN,
    process.env.FINAL_CHARGE_ADMIN_TOKEN
  ].filter(Boolean);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validAdminToken(token) {
  return allowedAdminTokens().some((allowed) => safeEqual(token, allowed));
}

function sign(value) {
  return crypto.createHmac('sha256', adminSecret()).update(value).digest('base64url');
}

function createAdminSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = crypto.randomBytes(18).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp: expiresAt, nonce })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function createCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function verifyAdminSession(value) {
  if (!value || !adminSecret()) return false;
  const [payload, signature] = String(value).split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.role === 'admin' && Number(decoded.exp || 0) > Math.floor(Date.now() / 1000);
  } catch (err) {
    return false;
  }
}

function hasAdminSession(req) {
  return verifyAdminSession(parseCookies(req)[ADMIN_COOKIE]);
}

function csrfTokenFromRequest(req) {
  return String(req.headers['x-csrf-token'] || req.headers['x-admin-csrf-token'] || '');
}

function verifyCsrf(req) {
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = csrfTokenFromRequest(req);
  return Boolean(cookieToken && headerToken && safeEqual(cookieToken, headerToken));
}

function requireCsrf(req, res) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.headers['x-admin-token'] || String(req.headers.authorization || '').startsWith('Bearer ')) return true;
  if (verifyCsrf(req)) return true;
  res.status(403).json({ error: 'Invalid admin security token.' });
  return false;
}

function sessionCookie(value) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Strict${secure}`;
}

function csrfCookie(value) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${CSRF_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Strict${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${ADMIN_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure}`;
}

function clearCsrfCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
}

export {
  ADMIN_COOKIE,
  CSRF_COOKIE,
  clearCsrfCookie,
  clearSessionCookie,
  createCsrfToken,
  createAdminSession,
  csrfCookie,
  hasAdminSession,
  requireCsrf,
  sessionCookie,
  validAdminToken,
  verifyCsrf,
  verifyAdminSession
};
