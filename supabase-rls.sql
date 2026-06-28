-- yogacloak CRM lockdown
-- Run this in Supabase after supabase-schema.sql.
--
-- These tables are private business records. The website and admin hub should
-- access them only through Vercel server functions that use SUPABASE_SERVICE_ROLE_KEY.
-- No public anon/authenticated browser policies are created here, so RLS denies
-- direct browser reads/writes by default.

alter table if exists customers enable row level security;
alter table if exists inquiries enable row level security;
alter table if exists reservations enable row level security;
alter table if exists payments enable row level security;
alter table if exists payment_methods enable row level security;
alter table if exists customer_events enable row level security;
alter table if exists communications enable row level security;
alter table if exists internal_notes enable row level security;
alter table if exists admin_actions enable row level security;
alter table if exists airtable_sync_log enable row level security;

comment on table customers is 'Private yogacloak CRM customers. RLS enabled; server-only access via service role.';
comment on table inquiries is 'Private customer inquiries. RLS enabled; server-only access via service role.';
comment on table reservations is 'Private product reservations. RLS enabled; server-only access via service role.';
comment on table payments is 'Private operational payment records. Stripe remains source of truth.';
comment on table payment_methods is 'Non-card payment method references only. No raw card data.';
comment on table communications is 'Private inbound/outbound customer communication history.';
comment on table internal_notes is 'Private owner CRM notes.';
comment on table admin_actions is 'Private admin audit trail.';
