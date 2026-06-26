// Protected endpoint: exports subscribed SMS opt-ins for CRM import/sync.
// GET /api/sms-optins-export with x-admin-token.

import {
  TABLES,
  listRecords,
  parseNotes,
  requireAdmin
} from '../lib/yogacloak-ops.js';

const FORMS_TABLE_FALLBACK = TABLES.forms;

function tableId() {
  return process.env.AIRTABLE_SMS_OPTINS_TABLE
    || process.env.AIRTABLE_SMS_TABLE
    || process.env.AIRTABLE_FORMS_TABLE
    || FORMS_TABLE_FALLBACK;
}

function csvCell(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function fieldOrNote(fields, notes, fieldName, noteName) {
  return fields[fieldName] || notes[noteName] || '';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;

  try {
    const records = await listRecords(tableId());

    const rows = records.map((record) => {
      const fields = record.fields || {};
      const notes = parseNotes(fields.Notes);
      return {
        phone: fieldOrNote(fields, notes, 'Phone', 'phone'),
        sms_status: fieldOrNote(fields, notes, 'SMS Status', 'sms_status') || 'Subscribed',
        opt_in_timestamp: fieldOrNote(fields, notes, 'Opt-In Timestamp', 'opt_in_timestamp') || fields['Submission Date'] || '',
        source_page: fieldOrNote(fields, notes, 'Source Page', 'source_page'),
        consent_language_version: fieldOrNote(fields, notes, 'Consent Language Version', 'consent_language_version'),
        consent_text: fieldOrNote(fields, notes, 'Consent Text', 'consent_text'),
        tags: fields.Tags || (Array.isArray(notes.tags) ? notes.tags.join(', ') : ''),
        crm_sync_status: fieldOrNote(fields, notes, 'CRM Sync Status', 'crm_sync_status') || 'Ready to Sync'
      };
    }).filter((row, index) => {
      const fields = records[index].fields || {};
      return row.phone && (row.sms_status === 'Subscribed' || fields['Form Type'] === 'SMS Opt-In');
    });

    if (req.query?.format === 'json') {
      return res.status(200).json({ ok: true, subscribers: rows });
    }

    const header = ['phone', 'sms_status', 'opt_in_timestamp', 'source_page', 'consent_language_version', 'consent_text', 'tags', 'crm_sync_status'];
    const csv = [
      header.join(','),
      ...rows.map((row) => header.map((key) => csvCell(row[key])).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="yogacloak-sms-optins.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    console.error('SMS opt-in export error:', err);
    return res.status(500).json({ error: 'Could not export SMS opt-ins.' });
  }
}
