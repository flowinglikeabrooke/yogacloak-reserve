// Protected endpoint: one Vercel Hobby-safe daily cron that runs YogaCloak ops in order.
// GET /api/daily-ops-runner with Authorization: Bearer CRON_SECRET.

import {
  requireAdmin,
  sendEmail
} from '../lib/yogacloak-ops.js';

const TASKS = [
  '/api/cleanup-pending-checkouts',
  '/api/send-abandoned-reservations',
  '/api/reconcile-stripe-airtable',
  '/api/low-inventory-alert',
  '/api/daily-owner-digest',
  '/api/seo-health-check'
];

function ownerEmail() {
  return process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_TO || 'hello@yogacloak.com';
}

function siteUrl(req) {
  const configured = process.env.SITE_URL || process.env.VERCEL_URL || '';
  const host = configured || req.headers.host || 'www.yogacloak.com';
  const withProtocol = host.startsWith('http') ? host : `https://${host}`;
  return withProtocol.replace(/\/$/, '');
}

async function runTask(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET || ''}`
    }
  });
  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    body = { text: await response.text().catch(() => '') };
  }
  return { path, ok: response.ok, status: response.status, body };
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  const baseUrl = siteUrl(req);
  const results = [];

  for (const path of TASKS) {
    try {
      results.push(await runTask(baseUrl, path));
    } catch (err) {
      results.push({ path, ok: false, status: 'failed', error: err.message });
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length) {
    try {
      await sendEmail({
        to: ownerEmail(),
        subject: `yogacloak daily ops: ${failures.length} task${failures.length === 1 ? '' : 's'} failed`,
        html: `
          <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
            <div style="max-width:620px;margin:0 auto">
              <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
              <h1 style="font-size:32px;line-height:1.05;font-weight:500;margin:18px 0">Daily ops needs a look.</h1>
              <p style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.72)">One or more scheduled backend tasks did not finish cleanly.</p>
              <pre style="white-space:pre-wrap;background:#151618;border:1px solid rgba(251,248,240,.12);border-radius:12px;padding:14px;color:rgba(251,248,240,.72);font-size:12px">${JSON.stringify(failures, null, 2)}</pre>
            </div>
          </div>
        `,
        text: `YogaCloak daily ops failures: ${JSON.stringify(failures, null, 2)}`
      });
    } catch (err) {
      console.error('Could not send daily ops failure email:', err);
    }
  }

  return res.status(failures.length ? 207 : 200).json({ ok: failures.length === 0, baseUrl, results });
}
