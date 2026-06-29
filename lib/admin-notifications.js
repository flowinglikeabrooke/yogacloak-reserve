const DEFAULT_FOUNDER_EMAIL = 'Brookebein@gmail.com';

function splitEmails(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

function uniqueEmails(values = []) {
  const seen = new Set();
  const emails = [];
  values.flat().forEach((email) => {
    const clean = String(email || '').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    emails.push(clean);
  });
  return emails;
}

function adminUserEmails(roles = []) {
  try {
    const allowed = new Set(roles);
    const parsed = JSON.parse(process.env.ADMIN_USERS_JSON || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((user) => allowed.has(String(user?.role || '').trim().toLowerCase()) && user?.status !== 'disabled')
      .map((user) => user.email)
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

function founderEmails() {
  return uniqueEmails([
    splitEmails(process.env.FOUNDER_EMAIL),
    splitEmails(process.env.BROOKE_EMAIL),
    splitEmails(process.env.OWNER_ADMIN_EMAIL),
    splitEmails(process.env.OWNER_EMAIL),
    splitEmails(process.env.ADMIN_EMAIL),
    splitEmails(process.env.EMAIL_TO),
    adminUserEmails(['founder']),
    splitEmails(process.env.FOUNDER_NOTIFICATION_EMAILS),
    DEFAULT_FOUNDER_EMAIL
  ]);
}

function ownerEmails() {
  return uniqueEmails([
    founderEmails(),
    splitEmails(process.env.CHRISTIAN_EMAIL),
    splitEmails(process.env.OWNER_NOTIFICATION_EMAILS),
    adminUserEmails(['founder', 'owner'])
  ]);
}

function notificationEmailsFor(audience = 'owners') {
  if (audience === 'founder' || audience === 'founder_only') return founderEmails();
  return ownerEmails();
}

function notificationLabelFor(audience = 'owners') {
  const emails = notificationEmailsFor(audience);
  return emails.length ? emails.join(', ') : DEFAULT_FOUNDER_EMAIL;
}

export {
  DEFAULT_FOUNDER_EMAIL,
  founderEmails,
  notificationEmailsFor,
  notificationLabelFor,
  ownerEmails
};
