// Protected endpoint: checks important public SEO pages and emails only on failures.
// GET /api/seo-health-check with Authorization: Bearer CRON_SECRET.

import {
  requireAdmin,
  sendEmail
} from '../yogacloak-ops.js';

function ownerEmail() {
  return process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_TO || 'hello@yogacloak.com';
}

function siteUrl() {
  const raw = process.env.SITE_URL || 'https://www.yogacloak.com';
  const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
  return withProtocol.replace(/\/$/, '');
}

const PATHS = [
  '/',
  '/yogacloak-reserve-page.html',
  '/sitemap.xml',
  '/robots.txt',
  '/hot-yoga-essentials.html',
  '/yogacloak-faq.html',
  '/yogacloak-privacy.html',
  '/yogacloak-terms.html'
];

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const base = siteUrl();
    const results = [];

    for (const path of PATHS) {
      const url = `${base}${path}`;
      try {
        const response = await fetch(url, { redirect: 'follow' });
        results.push({ path, url, status: response.status, ok: response.ok });
      } catch (err) {
        results.push({ path, url, status: 'fetch failed', ok: false });
      }
    }

    const failures = results.filter((result) => !result.ok);
    if (!failures.length) return res.status(200).json({ ok: true, failures: [] });

    const subject = `yogacloak site check: ${failures.length} page${failures.length === 1 ? '' : 's'} failing`;
    const html = `
      <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
        <div style="max-width:620px;margin:0 auto">
          <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
          <h1 style="font-size:32px;line-height:1.05;font-weight:500;margin:18px 0">Something is not loading.</h1>
          <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">The daily site-health check found these public pages returning an error:</p>
          <table style="width:100%;border-collapse:collapse;margin-top:16px">
            ${failures.map((failure) => `
              <tr>
                <td style="padding:10px 0;border-top:1px solid rgba(251,248,240,.12);color:rgba(251,248,240,.78);font-size:13px">${failure.path}</td>
                <td style="padding:10px 0;border-top:1px solid rgba(251,248,240,.12);color:rgba(251,248,240,.55);font-size:13px;text-align:right">${failure.status}</td>
              </tr>
            `).join('')}
          </table>
        </div>
      </div>
    `;

    await sendEmail({
      to: ownerEmail(),
      subject,
      html,
      text: `YogaCloak site-health check found failures: ${failures.map((failure) => `${failure.path} ${failure.status}`).join(', ')}`
    });

    return res.status(200).json({ ok: true, failures, results });
  } catch (err) {
    console.error('SEO health check error:', err);
    return res.status(500).json({ error: 'Could not run SEO health check.' });
  }
}
