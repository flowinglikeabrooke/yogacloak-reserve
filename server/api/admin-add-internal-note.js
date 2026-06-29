import { addInternalNote } from '../../lib/admin-hub-data.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await checkRateLimit(req, res, { maxRequests: 20, windowSeconds: 60, keyPrefix: 'admin-internal-note' }))) return;
  if (rejectLargeRequest(req, res, 16 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const body = String(req.body?.body || '').trim().slice(0, 5000);
    const noteType = String(req.body?.note_type || 'general').trim().slice(0, 80);
    const contactStatus = String(req.body?.contact_status || '').trim().slice(0, 80);
    const nextFollowUpAt = String(req.body?.next_follow_up_at || '').trim();
    if (!customerId || !body) return res.status(400).json({ error: 'Customer and note are required.' });
    const note = await addInternalNote({ customerId, body, noteType, contactStatus, nextFollowUpAt });
    await auditAdminAction(req, {
      actionType: 'add_internal_note',
      title: 'Admin added internal note',
      customerId,
      details: body,
      metadata: { note_type: noteType, contact_status: contactStatus, next_follow_up_at: nextFollowUpAt }
    });
    return res.status(200).json({ ok: true, note });
  } catch (err) {
    console.error('Admin internal note error:', err);
    return res.status(400).json({ error: err.message || 'Could not save note.' });
  }
}
