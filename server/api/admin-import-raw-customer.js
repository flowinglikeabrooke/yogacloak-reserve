import { importAirtableCustomer } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 10, windowSeconds: 60, keyPrefix: 'admin-import-raw-customer' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    const rawCustomerId = String(req.body?.customer_id || '').trim();
    if (!rawCustomerId) return res.status(400).json({ error: 'Raw customer ID is required.' });

    const imported = await importAirtableCustomer(rawCustomerId);
    await auditAdminAction(req, {
      actionType: 'import_raw_airtable_customer',
      title: 'Admin imported raw Airtable customer',
      customerId: imported.customer?.id || null,
      details: `Imported ${imported.imported_inquiries || 0} raw form record(s).`,
      metadata: {
        raw_customer_id: rawCustomerId,
        imported_inquiries: imported.imported_inquiries || 0
      }
    });

    return res.status(200).json({ ok: true, imported });
  } catch (err) {
    console.error('Admin raw customer import error:', err);
    return res.status(400).json({ error: err.message || 'Could not import raw customer.' });
  }
}
