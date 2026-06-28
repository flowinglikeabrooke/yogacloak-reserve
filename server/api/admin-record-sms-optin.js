import { auditAdminAction } from '../../lib/admin-audit.js';
import { runAutomationTrigger } from '../../lib/automations.js';
import { loadCustomerDetail, updateCustomerProfile } from '../../lib/admin-hub-data.js';
import { createCustomerEvent, recordInquiry } from '../../lib/customer-identity.js';
import { checkRateLimit, rejectLargeRequest, requireAdmin } from '../../lib/yogacloak-ops.js';

const CONSENT_TEXT = 'Customer gave yogacloak permission to send SMS updates. Msg & data rates may apply. Reply STOP to opt out.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 12, windowSeconds: 60, keyPrefix: 'admin-record-sms-optin' })) return;
  if (rejectLargeRequest(req, res, 10 * 1024)) return;
  if (!requireAdmin(req, res)) return;

  try {
    const customerId = String(req.body?.customer_id || '').trim();
    const phone = String(req.body?.phone || '').trim().slice(0, 80);
    const consentConfirmed = req.body?.consent_confirmed === true;
    const consentText = String(req.body?.consent_text || CONSENT_TEXT).trim().slice(0, 1000);
    if (!customerId) return res.status(400).json({ error: 'Customer is required.' });
    if (!consentConfirmed) return res.status(400).json({ error: 'Confirm consent before recording SMS opt-in.' });

    let detail = await loadCustomerDetail(customerId);
    let customer = detail?.customer;
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    if (String(customer.id || '').startsWith('airtable:') || customer.fallback_source === 'airtable_forms') {
      return res.status(400).json({ error: 'Import this raw backup customer into the private CRM before recording SMS opt-in.' });
    }

    const resolvedPhone = phone || customer.phone || customer.normalized_phone || '';
    if (!resolvedPhone) return res.status(400).json({ error: 'Add a customer phone number before recording SMS opt-in.' });

    if (phone && phone !== customer.phone) {
      customer = await updateCustomerProfile({
        customerId,
        fullName: customer.full_name || '',
        email: customer.email || '',
        phone,
        status: customer.status || 'lead',
        tags: customer.tags || []
      });
      detail = await loadCustomerDetail(customerId);
    }

    const activeOptIn = (detail.inquiries || []).find((row) => (
      row.inquiry_type === 'sms_opt_in'
      && ['subscribed', 'new'].includes(String(row.status || '').toLowerCase())
    ));
    if (activeOptIn) {
      return res.status(200).json({ ok: true, already_subscribed: true, inquiry: activeOptIn });
    }

    const now = new Date().toISOString();
    const submissionId = `admin_sms_${customerId}_${Date.now().toString(36)}`;
    const inquiry = await recordInquiry({
      customerId,
      type: 'sms_opt_in',
      sourcePage: 'Admin Hub',
      phone: resolvedPhone,
      productInterest: 'Launch updates',
      message: consentText,
      status: 'subscribed',
      eventTitle: 'SMS opt-in recorded by owner',
      metadata: {
        submission_id: submissionId,
        consent: {
          sms_opt_in: true,
          opt_in_timestamp: now,
          source_page: 'Admin Hub',
          consent_language_version: 'admin-owner-consent-v1',
          consent_text: consentText,
          consent_recorded_by: 'owner',
          consent_confirmed: true
        }
      }
    });

    await createCustomerEvent({
      customerId,
      type: 'sms_opt_in_recorded',
      title: 'SMS opt-in recorded by owner',
      details: 'Owner confirmed customer SMS consent in the admin hub.',
      metadata: { inquiry_id: inquiry?.id, submission_id: submissionId },
      occurredAt: now
    });

    await runAutomationTrigger('sms_opt_in_created', {
      customer: { ...customer, phone: resolvedPhone },
      inquiry
    });

    await auditAdminAction(req, {
      actionType: 'record_sms_opt_in',
      title: 'Admin recorded customer SMS opt-in',
      customerId,
      details: consentText,
      metadata: { inquiry_id: inquiry?.id, phone: resolvedPhone }
    });

    return res.status(200).json({ ok: true, inquiry });
  } catch (err) {
    console.error('Admin SMS opt-in error:', err);
    return res.status(400).json({ error: err.message || 'Could not record SMS opt-in.' });
  }
}
