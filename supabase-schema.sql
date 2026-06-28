create extension if not exists pgcrypto;

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  first_name text,
  last_name text,
  full_name text,
  email text,
  normalized_email text,
  phone text,
  normalized_phone text,
  stripe_customer_id text,
  status text default 'lead',
  contact_status text default 'not_contacted',
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  source text,
  owner_note text,
  notes jsonb default '{}'::jsonb,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists customers_normalized_email_idx
  on customers (normalized_email)
  where normalized_email is not null and normalized_email <> '';

create unique index if not exists customers_normalized_phone_idx
  on customers (normalized_phone)
  where normalized_phone is not null and normalized_phone <> '';

create unique index if not exists customers_stripe_customer_id_idx
  on customers (stripe_customer_id)
  where stripe_customer_id is not null and stripe_customer_id <> '';

create table if not exists inquiries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  inquiry_type text default 'contact',
  source_page text,
  product_interest text,
  size_interest text,
  message text,
  email text,
  phone text,
  status text default 'new',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  airtable_reservation_id text,
  airtable_contact_id text,
  status text default 'Pending Payment',
  product_selection jsonb default '[]'::jsonb,
  size text,
  deposit_amount numeric(10,2) default 0,
  final_retail_total numeric(10,2) default 0,
  final_balance_total numeric(10,2) default 0,
  checkout_session_id text,
  checkout_url text,
  payment_intent_id text,
  final_balance_payment_intent_id text,
  stripe_customer_id text,
  stripe_payment_method_id text,
  future_charge_authorized boolean default false,
  final_balance_notice_sent_at timestamptz,
  final_balance_charged_at timestamptz,
  final_balance_status text,
  notes jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists reservations_airtable_reservation_id_idx
  on reservations (airtable_reservation_id)
  where airtable_reservation_id is not null and airtable_reservation_id <> '';

create unique index if not exists reservations_checkout_session_id_idx
  on reservations (checkout_session_id)
  where checkout_session_id is not null and checkout_session_id <> '';

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  reservation_id uuid references reservations(id) on delete set null,
  airtable_payment_id text,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  amount numeric(10,2) default 0,
  payment_type text,
  status text,
  fee_amount numeric(10,2),
  net_amount numeric(10,2),
  metadata jsonb default '{}'::jsonb,
  occurred_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists payments_stripe_payment_intent_id_idx
  on payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null and stripe_payment_intent_id <> '';

create table if not exists payment_methods (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  stripe_customer_id text,
  stripe_payment_method_id text,
  brand text,
  last4 text,
  exp_month integer,
  exp_year integer,
  future_charge_authorized boolean default false,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists payment_methods_stripe_payment_method_id_idx
  on payment_methods (stripe_payment_method_id)
  where stripe_payment_method_id is not null and stripe_payment_method_id <> '';

create table if not exists customer_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  event_type text,
  title text,
  details text,
  metadata jsonb default '{}'::jsonb,
  occurred_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists communications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  channel text,
  direction text default 'outbound',
  subject text,
  body text,
  status text,
  provider text,
  provider_id text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists internal_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  note_type text default 'general',
  contact_status text,
  body text not null,
  next_follow_up_at timestamptz,
  created_by text default 'owner',
  created_at timestamptz default now()
);

create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  reservation_id uuid references reservations(id) on delete set null,
  action_type text,
  title text,
  details text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists airtable_sync_log (
  id uuid primary key default gen_random_uuid(),
  local_table text,
  local_id uuid,
  airtable_table text,
  airtable_record_id text,
  sync_status text,
  error text,
  synced_at timestamptz,
  created_at timestamptz default now()
);
