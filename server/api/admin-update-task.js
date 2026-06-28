import { auditAdminAction } from '../../lib/admin-audit.js';
import { updateOwnerTask } from '../../lib/owner-tasks.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 40, windowSeconds: 60, keyPrefix: 'admin-update-task' })) return;
  if (rejectLargeRequest(req, res, 12 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const task = await updateOwnerTask({
      task_id: req.body?.task_id,
      task_type: req.body?.task_type,
      title: req.body?.title,
      description: req.body?.description,
      status: req.body?.status,
      priority: req.body?.priority,
      due_at: req.body?.due_at
    });
    await auditAdminAction(req, {
      actionType: 'update_task',
      title: 'Admin updated task',
      customerId: task.customer_id,
      reservationId: task.reservation_id,
      details: `${task.status}: ${task.title}`,
      metadata: { task_id: task.id, task_type: task.task_type, priority: task.priority, due_at: task.due_at }
    });
    return res.status(200).json({ ok: true, task });
  } catch (err) {
    console.error('Admin update task error:', err);
    return res.status(400).json({ error: err.message || 'Could not update task.' });
  }
}
