import { syncAirtableRawToCrm } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 4, windowSeconds: 60, keyPrefix: 'admin-sync-raw-airtable' })) return;
  if (rejectLargeRequest(req, res, 4 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const limit = Math.min(Math.max(Number(req.body?.limit || 500), 1), 1000);
    const sync = await syncAirtableRawToCrm({ limit });
    await auditAdminAction(req, {
      actionType: 'sync_raw_airtable',
      title: 'Admin synced Airtable raw backup into CRM',
      details: `Checked ${sync.summary.raw_records_checked} raw record(s).`,
      metadata: sync.summary
    });
    return res.status(200).json({ ok: true, sync });
  } catch (err) {
    if (!String(err.message || '').includes('Private CRM database is not configured')) {
      console.error('Admin raw Airtable sync error:', err);
    }
    return res.status(400).json({ error: err.message || 'Could not sync Airtable raw backup.' });
  }
}
