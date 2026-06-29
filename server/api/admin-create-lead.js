import { auditAdminAction } from '../../lib/admin-audit.js';
import { runAutomationTrigger } from '../../lib/automations.js';
import { findOrCreateCustomer, recordInquiry } from '../../lib/customer-identity.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

async function saveLeadToAirtable(fields) {
  const pat = process.env.AIRTABLE_PAT;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableId = process.env.AIRTABLE_FORMS_TABLE;
  if (!pat || !baseId || !tableId) return { skipped: true };

  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Airtable lead backup failed: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await checkRateLimit(req, res, { maxRequests: 20, windowSeconds: 60, keyPrefix: 'admin-create-lead' }))) return;
  if (rejectLargeRequest(req, res, 16 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const fullName = clean(req.body?.full_name || req.body?.name, 240).replace(/\s+/g, ' ');
    const email = clean(req.body?.email, 240).toLowerCase();
    const phone = clean(req.body?.phone, 80);
    const message = clean(req.body?.message || req.body?.notes, 5000);
    const source = clean(req.body?.source || 'Grassroots', 120);
    const productInterest = clean(req.body?.product_interest, 240);

    if (!fullName) return res.status(400).json({ error: 'Full name is required.' });
    if (!email && !phone) return res.status(400).json({ error: 'Add at least an email or phone.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email.' });
    if (phone && phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Invalid phone.' });

    const parts = fullName.split(' ');
    const firstName = parts.shift() || '';
    const lastName = parts.join(' ');
    const now = new Date();
    const submissionId = `admin_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const identity = await findOrCreateCustomer({
      firstName,
      lastName,
      fullName,
      email,
      phone,
      status: 'lead',
      source,
      reason: `Lead added by ${req.adminUser?.name || 'admin'} from ${source}.`
    });

    if (!identity.customer?.id) return res.status(500).json({ error: 'Private CRM database is not connected.' });

    const inquiry = await recordInquiry({
      customerId: identity.customer.id,
      type: 'grassroots_lead',
      sourcePage: source,
      productInterest,
      message,
      email,
      phone,
      status: 'new',
      eventTitle: 'Grassroots lead added',
      metadata: {
        submission_id: submissionId,
        customer_match: identity.created ? 'new_customer' : 'existing_customer',
        intake_summary: identity.created ? 'New lead added by owner' : 'Added lead activity to existing contact',
        added_by_admin: req.adminUser?.email || req.adminUser?.name || 'admin',
        source
      }
    });

    await runAutomationTrigger('inquiry_created', {
      customer: identity.customer,
      inquiry
    });

    let airtable = { skipped: true };
    try {
      airtable = await saveLeadToAirtable({
        'Submission ID': submissionId,
        'Submission Date': now.toISOString(),
        'First Name': firstName,
        'Last Name': lastName,
        ...(email ? { Email: email } : {}),
        ...(phone ? { Phone: phone } : {}),
        'Notes': message || `Lead added by ${req.adminUser?.name || 'admin'} from ${source}.`,
        'Source Page': source,
        'Form Type': 'Grassroots Lead',
        'Lead Source': source,
        ...(productInterest ? { 'Product Interest': productInterest } : {})
      });
    } catch (err) {
      console.warn('Airtable lead backup failed:', err.message);
      airtable = { error: true };
    }

    await auditAdminAction(req, {
      actionType: 'create_lead',
      title: 'Admin added grassroots lead',
      customerId: identity.customer.id,
      details: `${fullName} · ${source}`,
      metadata: { inquiry_id: inquiry?.id, source, airtable_backup: airtable }
    });

    return res.status(200).json({ ok: true, customer: identity.customer, inquiry, airtable });
  } catch (err) {
    console.error('Admin create lead error:', err);
    return res.status(400).json({ error: err.message || 'Could not add lead.' });
  }
}
