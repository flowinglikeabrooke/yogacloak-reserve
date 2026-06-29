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

function stableId(value) {
  return crypto.createHash('sha256').update(String(value || 'admin')).digest('hex').slice(0, 16);
}

function cleanRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (['founder', 'owner', 'manager', 'staff'].includes(role)) return role;
  return 'staff';
}

function publicAdminUser(user = {}) {
  const role = cleanRole(user.role || 'owner');
  const email = String(user.email || '').trim();
  const name = String(user.name || user.full_name || (['founder', 'owner'].includes(role) ? 'Owner' : 'Team member')).trim();
  return {
    id: String(user.id || stableId(email || name || role)),
    email,
    name,
    role
  };
}

function envAdminUsers() {
  const users = [];
  try {
    const parsed = JSON.parse(process.env.ADMIN_USERS_JSON || '[]');
    if (Array.isArray(parsed)) {
      parsed.forEach((item) => {
        const token = String(item?.token || item?.access_code || '').trim();
        if (!token || item?.status === 'disabled') return;
        users.push({
          ...publicAdminUser(item),
          token
        });
      });
    }
  } catch (err) {
    console.warn('ADMIN_USERS_JSON could not be parsed:', err.message);
  }

  if (process.env.ADMIN_TOKEN) {
    users.push({
      id: stableId(process.env.OWNER_ADMIN_EMAIL || 'owner'),
      email: String(process.env.OWNER_ADMIN_EMAIL || '').trim(),
      name: String(process.env.OWNER_ADMIN_NAME || 'Brooke').trim(),
      role: 'founder',
      token: process.env.ADMIN_TOKEN
    });
  }

  if (process.env.FINAL_CHARGE_ADMIN_TOKEN && process.env.FINAL_CHARGE_ADMIN_TOKEN !== process.env.ADMIN_TOKEN) {
    users.push({
      id: stableId('final-charge-owner'),
      email: String(process.env.OWNER_ADMIN_EMAIL || '').trim(),
      name: String(process.env.OWNER_ADMIN_NAME || 'Owner').trim(),
      role: 'founder',
      token: process.env.FINAL_CHARGE_ADMIN_TOKEN
    });
  }

  return users;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function adminUserForToken(token) {
  const provided = String(token || '').trim();
  if (!provided) return null;
  const match = envAdminUsers().find((user) => safeEqual(provided, user.token));
  return match ? publicAdminUser(match) : null;
}

function validAdminToken(token) {
  return Boolean(adminUserForToken(token) || allowedAdminTokens().some((allowed) => safeEqual(token, allowed)));
}

function sign(value) {
  return crypto.createHmac('sha256', adminSecret()).update(value).digest('base64url');
}

function createAdminSession(user = {}) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = crypto.randomBytes(18).toString('base64url');
  const adminUser = publicAdminUser(user);
  const payload = Buffer.from(JSON.stringify({ ...adminUser, exp: expiresAt, nonce })).toString('base64url');
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
  return Boolean(getAdminSessionFromCookieValue(value));
}

function getAdminSessionFromCookieValue(value) {
  if (!value || !adminSecret()) return null;
  const [payload, signature] = String(value).split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Number(decoded.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
    const role = decoded.role === 'admin' ? 'founder' : cleanRole(decoded.role);
    return publicAdminUser({ ...decoded, role });
  } catch (err) {
    return null;
  }
}

function getAdminSession(req) {
  return getAdminSessionFromCookieValue(parseCookies(req)[ADMIN_COOKIE]);
}

function hasAdminSession(req) {
  return Boolean(getAdminSession(req));
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
  adminUserForToken,
  getAdminSession,
  hasAdminSession,
  publicAdminUser,
  requireCsrf,
  sessionCookie,
  validAdminToken,
  verifyCsrf,
  verifyAdminSession
};
