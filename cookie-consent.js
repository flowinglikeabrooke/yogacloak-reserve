// Vercel endpoint: /api/cookie-consent
// Stores the visitor's cookie preference in an essential first-party cookie.

const ALLOWED = new Set(['all', 'essential']);
const MAX_AGE = 60 * 60 * 24 * 180;

function serializeCookie(value) {
  const payload = encodeURIComponent(JSON.stringify({
    choice: value,
    analytics: value === 'all',
    marketing: value === 'all',
    updated_at: new Date().toISOString(),
    version: 'cookie-consent-v1'
  }));

  return [
    `yc_cookie_consent=${payload}`,
    'Path=/',
    `Max-Age=${MAX_AGE}`,
    'SameSite=Lax',
    'Secure'
  ].join('; ');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const choice = String(body.choice || '').trim().toLowerCase();

    if (!ALLOWED.has(choice)) {
      return res.status(400).json({ error: 'Invalid cookie choice' });
    }

    res.setHeader('Set-Cookie', serializeCookie(choice));
    return res.status(200).json({
      ok: true,
      choice,
      analytics: choice === 'all',
      marketing: choice === 'all'
    });
  } catch (err) {
    console.error('Cookie consent endpoint error:', err);
    return res.status(500).json({ error: 'Could not save cookie preference' });
  }
}
