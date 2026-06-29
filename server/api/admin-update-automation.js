import { updateAutomationRule } from '../../lib/automations.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import { checkRateLimit, rejectLargeRequest, requireOwner } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 20, windowSeconds: 60, keyPrefix: 'admin-update-automation' })) return;
  if (rejectLargeRequest(req, res, 12 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    const automation = await updateAutomationRule({
      id: String(req.body?.id || '').trim(),
      key: String(req.body?.key || '').trim(),
      enabled: req.body?.enabled,
      mode: String(req.body?.mode || '').trim(),
      subjectTemplate: req.body?.subject_template,
      bodyTemplate: req.body?.body_template
    });
    await auditAdminAction(req, {
      actionType: 'update_automation',
      title: 'Admin updated automation rule',
      details: automation.name || automation.key,
      metadata: {
        automation_id: automation.id,
        automation_key: automation.key,
        enabled: automation.enabled,
        mode: automation.mode,
        channel: automation.channel,
        trigger_type: automation.trigger_type
      }
    });
    return res.status(200).json({ ok: true, automation });
  } catch (err) {
    console.error('Admin update automation error:', err);
    return res.status(400).json({ error: err.message || 'Could not update automation.' });
  }
}
