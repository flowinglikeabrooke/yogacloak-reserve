import { databaseEnabled, insertRow, selectOne, selectRows, updateRows } from './database.js';
import { createCustomerEvent } from './customer-identity.js';

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeEmail(value) {
  return clean(value, 240).toLowerCase();
}

function normalizePhone(value) {
  const digits = clean(value, 80).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `1${digits}` : digits;
}

function nameFromLookup(input = {}) {
  return clean(input.customer_name || `${clean(input.customer_first_name, 120)} ${clean(input.customer_last_name, 120)}`.trim(), 240);
}

function normalizeTaskStatus(value) {
  const status = clean(value || 'open', 80).toLowerCase();
  return ['open', 'in_progress', 'waiting', 'done', 'archived'].includes(status) ? status : 'open';
}

function normalizePriority(value) {
  const priority = clean(value || 'normal', 40).toLowerCase();
  return ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal';
}

function dueFilter(filter) {
  const now = new Date().toISOString();
  if (filter === 'overdue') return { due_at: `lt.${now}`, status: 'in.(open,in_progress,waiting)' };
  if (filter === 'done') return { status: 'eq.done' };
  if (filter === 'active') return { status: 'in.(open,in_progress,waiting)' };
  return {};
}

async function loadOwnerTasks({ status = '', customerId = '', limit = 250 } = {}) {
  if (!databaseEnabled()) return [];
  const filters = {};
  if (customerId) filters.customer_id = `eq.${customerId}`;
  if (status) Object.assign(filters, dueFilter(status));
  const rows = await selectRows('owner_tasks', {
    select: '*,customers(id,full_name,email,phone),inquiries(id,inquiry_type,message,source_page,product_interest),reservations(id,status,product_selection,airtable_reservation_id)',
    filters,
    order: 'due_at.asc.nullslast,created_at.desc',
    limit
  });
  return rows || [];
}

async function taskStats() {
  const tasks = await loadOwnerTasks({ limit: 500 });
  const now = Date.now();
  const active = tasks.filter((task) => ['open', 'in_progress', 'waiting'].includes(task.status));
  return {
    total: tasks.length,
    active: active.length,
    overdue: active.filter((task) => task.due_at && Date.parse(task.due_at) < now).length,
    urgent: active.filter((task) => task.priority === 'urgent' || task.priority === 'high').length,
    done: tasks.filter((task) => task.status === 'done').length
  };
}

async function findCustomerForTask(input = {}) {
  const explicitId = clean(input.customerId || input.customer_id, 80);
  if (explicitId) return explicitId;

  const email = normalizeEmail(input.customerEmail || input.customer_email);
  const phone = normalizePhone(input.customerPhone || input.customer_phone);
  const name = nameFromLookup(input);
  const lookupSupplied = Boolean(email || phone || name);
  if (!lookupSupplied) return null;

  if (email) {
    const customer = await selectOne('customers', { filters: { normalized_email: `eq.${email}` } });
    if (customer?.id) return customer.id;
  }

  if (phone) {
    const customer = await selectOne('customers', { filters: { normalized_phone: `eq.${phone}` } });
    if (customer?.id) return customer.id;
  }

  if (name) {
    const rows = await selectRows('customers', {
      filters: { full_name: `ilike.*${name.replace(/[%*]/g, '')}*` },
      limit: 10
    });
    const exact = (rows || []).filter((row) => clean(row.full_name).toLowerCase() === name.toLowerCase());
    const matches = exact.length ? exact : (rows || []);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      throw new Error('More than one customer matched that name. Add their email or phone to link the task.');
    }
  }

  throw new Error('No customer matched that name, email, or phone. Leave the contact fields blank for a general task.');
}

async function createOwnerTask(input = {}) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not connected.');
  const title = clean(input.title, 240);
  if (!title) throw new Error('Task title is required.');
  const now = new Date().toISOString();
  const customerId = await findCustomerForTask(input);
  const task = await insertRow('owner_tasks', {
    customer_id: customerId,
    inquiry_id: clean(input.inquiryId || input.inquiry_id, 80) || null,
    reservation_id: clean(input.reservationId || input.reservation_id, 80) || null,
    task_type: clean(input.taskType || input.task_type || 'general', 80),
    title,
    description: clean(input.description, 4000),
    status: normalizeTaskStatus(input.status),
    priority: normalizePriority(input.priority),
    due_at: clean(input.dueAt || input.due_at, 80) || null,
    created_by: 'owner',
    metadata: {
      ...(input.metadata || {}),
      customer_lookup: {
        name: nameFromLookup(input),
        email: normalizeEmail(input.customerEmail || input.customer_email),
        phone: normalizePhone(input.customerPhone || input.customer_phone)
      }
    },
    created_at: now,
    updated_at: now
  });
  if (task?.customer_id) {
    await createCustomerEvent({
      customerId: task.customer_id,
      type: 'task_created',
      title: 'Owner task created',
      details: title,
      metadata: { task_id: task.id, task_type: task.task_type, due_at: task.due_at, priority: task.priority },
      occurredAt: now
    });
  }
  return task;
}

async function updateOwnerTask(input = {}) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not connected.');
  const taskId = clean(input.taskId || input.task_id, 80);
  if (!taskId) throw new Error('Task is required.');
  const existing = await selectOne('owner_tasks', { filters: { id: `eq.${taskId}` } });
  if (!existing) throw new Error('Task not found.');
  const now = new Date().toISOString();
  const status = input.status !== undefined ? normalizeTaskStatus(input.status) : existing.status;
  const patch = {
    title: input.title !== undefined ? clean(input.title, 240) : existing.title,
    description: input.description !== undefined ? clean(input.description, 4000) : existing.description,
    task_type: input.taskType !== undefined || input.task_type !== undefined ? clean(input.taskType || input.task_type || 'general', 80) : existing.task_type,
    status,
    priority: input.priority !== undefined ? normalizePriority(input.priority) : existing.priority,
    due_at: input.dueAt !== undefined || input.due_at !== undefined ? (clean(input.dueAt || input.due_at, 80) || null) : existing.due_at,
    completed_at: status === 'done' && existing.status !== 'done' ? now : (status !== 'done' ? null : existing.completed_at),
    updated_at: now
  };
  const rows = await updateRows('owner_tasks', { id: `eq.${taskId}` }, patch);
  const task = rows[0] || existing;
  if (task.customer_id) {
    await createCustomerEvent({
      customerId: task.customer_id,
      type: status === 'done' ? 'task_completed' : 'task_updated',
      title: status === 'done' ? 'Owner task completed' : 'Owner task updated',
      details: task.title,
      metadata: { task_id: task.id, task_type: task.task_type, due_at: task.due_at, priority: task.priority, status },
      occurredAt: now
    });
  }
  return task;
}

export {
  createOwnerTask,
  loadOwnerTasks,
  taskStats,
  updateOwnerTask
};
