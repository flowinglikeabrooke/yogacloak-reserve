// Protected endpoint: one Vercel Hobby-safe daily cron that runs YogaCloak ops in order.
// GET /api/daily-ops-runner with Authorization: Bearer CRON_SECRET.
//
// The individual jobs live in lib/jobs/ (not api/) so they do not each count as a
// separate Vercel Serverless Function. They are invoked in-process below.

import { requireAdmin, sendEmail } from '../lib/yogacloak-ops.js';
import cleanupPendingCheckouts from '../lib/jobs/cleanup-pending-checkouts.js';
import sendAbandonedReservations from '../lib/jobs/send-abandoned-reservations.js';
import reconcileStripeAirtable from '../lib/jobs/reconcile-stripe-airtable.js';
import lowInventoryAlert from '../lib/jobs/low-inventory-alert.js';
import dailyOwnerDigest from '../lib/jobs/daily-owner-digest.js';
import seoHealthCheck from '../lib/jobs/seo-health-check.js';

const TASKS = [
  ['cleanup-pending-checkouts', cleanupPendingCheckouts],
  ['send-abandoned-reservations', sendAbandonedReservations],
  ['reconcile-stripe-airtable', reconcileStripeAirtable],
  ['low-inventory-alert', lowInventoryAlert],
  ['daily-owner-digest', dailyOwnerDigest],
  ['seo-health-check', seoHealthCheck]
];

function ownerEmail() {
  return process.env.OWNER_EMAIL || process.env.ADMIN_EMAIL || process.env.EMAIL_TO || 'hello@yogacloak.com';
}

// Run a job handler in-process by giving it a minimal req/res it understands.
// The job already authenticates via requireAdmin, so we pass the cron secret.
async function runTask(name, handler) {
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET || ''}` }
  };

  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
    setHeader() { return this; },
    end() { return this; }
  };

  try {
    await handler(req, res);
    return { path: `/api/${name}`, ok: statusCode >= 200 && statusCode < 300, status: statusCode, body: payload };
  } catch (err) {
    return { path: `/api/${name}`, ok: false, status: 'failed', error: err.message };
  }
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  const results = [];
  for (const [name, taskHandler] of TASKS) {
    results.push(await runTask(name, taskHandler));
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

  return res.status(failures.length ? 207 : 200).json({ ok: failures.length === 0, results });
}
