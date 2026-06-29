import { databaseEnabled, insertRow } from './database.js';
import { getAdminSession } from './admin-auth.js';

function requestMeta(req) {
  return {
    ip: String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '',
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    path: req.url || ''
  };
}

async function auditAdminAction(req, { actionType, title, details = '', customerId = null, reservationId = null, metadata = {} }) {
  if (!databaseEnabled()) return null;
  const actor = req.adminUser || getAdminSession(req) || null;
  try {
    return await insertRow('admin_actions', {
      customer_id: customerId || null,
      reservation_id: reservationId || null,
      admin_user_id: actor?.id || null,
      admin_user_email: actor?.email || null,
      admin_user_name: actor?.name || null,
      admin_user_role: actor?.role || null,
      action_type: String(actionType || 'admin_action').slice(0, 100),
      title: String(title || actionType || 'Admin action').slice(0, 240),
      details: String(details || '').slice(0, 4000),
      metadata: { ...requestMeta(req), actor, ...metadata },
      created_at: new Date().toISOString()
    });
  } catch (err) {
    console.warn('Admin audit log failed:', err.message);
    return null;
  }
}

export { auditAdminAction };
