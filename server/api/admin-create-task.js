import { auditAdminAction } from '../../lib/admin-audit.js';
import { createOwnerTask } from '../../lib/owner-tasks.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await checkRateLimit(req, res, { maxRequests: 30, windowSeconds: 60, keyPrefix: 'admin-create-task' }))) return;
  if (rejectLargeRequest(req, res, 12 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const task = await createOwnerTask({
      customer_id: req.body?.customer_id,
      customer_first_name: req.body?.customer_first_name,
      customer_last_name: req.body?.customer_last_name,
      customer_name: req.body?.customer_name,
      customer_email: req.body?.customer_email,
      customer_phone: req.body?.customer_phone,
      inquiry_id: req.body?.inquiry_id,
      reservation_id: req.body?.reservation_id,
      task_type: req.body?.task_type,
      title: req.body?.title,
      description: req.body?.description,
      priority: req.body?.priority,
      due_at: req.body?.due_at,
      metadata: req.body?.metadata || {}
    });
    await auditAdminAction(req, {
      actionType: 'create_task',
      title: 'Admin created task',
      customerId: task.customer_id,
      reservationId: task.reservation_id,
      details: task.title,
      metadata: { task_id: task.id, task_type: task.task_type, priority: task.priority, due_at: task.due_at }
    });
    return res.status(200).json({ ok: true, task });
  } catch (err) {
    console.error('Admin create task error:', err);
    return res.status(400).json({ error: err.message || 'Could not create task.' });
  }
}
