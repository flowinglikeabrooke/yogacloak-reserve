function configured(name) {
  return Boolean(process.env[name]);
}

function stripeMode() {
  const key = process.env.STRIPE_SECRET_KEY || process.env.RESERVE_STRIPE_SECRET_KEY || '';
  if (key.startsWith('sk_live_')) return 'live';
  if (key.startsWith('sk_test_')) return 'test';
  return key ? 'configured' : 'missing';
}

function loadSecurityStatus() {
  return {
    admin_session_secret_configured: configured('ADMIN_SESSION_SECRET'),
    admin_token_configured: configured('ADMIN_TOKEN') || configured('FINAL_CHARGE_ADMIN_TOKEN'),
    google_admin_login_configured: configured('GOOGLE_ADMIN_CLIENT_ID') || configured('GOOGLE_CLIENT_ID'),
    supabase_configured: configured('SUPABASE_URL') && configured('SUPABASE_SERVICE_ROLE_KEY'),
    stripe_mode: stripeMode(),
    stripe_webhook_secret_configured: configured('STRIPE_WEBHOOK_SECRET') || configured('RESERVE_STRIPE_WEBHOOK_SECRET'),
    allow_live_final_charges: process.env.ALLOW_LIVE_FINAL_CHARGES === 'true',
    twilio_configured: configured('TWILIO_ACCOUNT_SID') && configured('TWILIO_AUTH_TOKEN') && (configured('TWILIO_FROM_NUMBER') || configured('TWILIO_MESSAGING_SERVICE_SID')),
    twilio_signature_verification: configured('TWILIO_AUTH_TOKEN') && process.env.TWILIO_VALIDATE_WEBHOOKS !== 'false',
    sms_webhook_secret_configured: configured('SMS_WEBHOOK_SECRET') || configured('TWILIO_WEBHOOK_SECRET'),
    email_provider_configured: configured('RESEND_API_KEY') && configured('EMAIL_FROM'),
    email_webhook_secret_configured: configured('EMAIL_WEBHOOK_SECRET') || configured('RESEND_WEBHOOK_SECRET'),
    email_unsigned_webhook_allowed: process.env.EMAIL_WEBHOOK_ALLOW_UNSIGNED === 'true',
    rls_file_present: true
  };
}

export { loadSecurityStatus };
