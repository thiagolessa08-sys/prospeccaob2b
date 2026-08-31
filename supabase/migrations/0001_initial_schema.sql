create extension if not exists "pgcrypto";

create type lead_stage as enum (
  'discovered', 'enriched', 'contacted', 'in_conversation',
  'meeting_booked', 'discarded', 'error'
);

create type reply_intent as enum (
  'interested', 'question_or_objection', 'not_now', 'no', 'opt_out', 'out_of_scope'
);

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  niche_description text not null,
  filters jsonb,
  offer_description text not null,
  tone text not null default 'consultivo, direto, sem jargão',
  scheduling_link text not null,
  daily_send_limit int not null default 20,
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now()
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  cnpj text,
  legal_name text not null,
  trade_name text,
  website text,
  city text,
  uf text,
  employee_count int,
  summary text,
  source text not null,
  enrichment_status text not null default 'pending'
    check (enrichment_status in ('pending', 'enriched', 'failed')),
  created_at timestamptz not null default now()
);
create unique index companies_tenant_cnpj_uniq
  on companies (tenant_id, cnpj) where cnpj is not null;
create index companies_enrichment_idx
  on companies (tenant_id, enrichment_status);

create table leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  full_name text,
  role_title text,
  email text not null,
  email_verified boolean not null default false,
  stage lead_stage not null default 'enriched',
  discard_reason text,
  exchange_count int not null default 0,
  resume_at timestamptz,
  needs_human boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index leads_tenant_email_uniq on leads (tenant_id, lower(email));
create index leads_stage_idx on leads (tenant_id, stage);

create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  subject text,
  body text not null,
  intent reply_intent,
  confidence numeric,
  ai_reasoning text,
  external_id text,
  created_at timestamptz not null default now()
);
create index messages_lead_idx on messages (lead_id, created_at);

create table suppression_list (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  value text not null,
  kind text not null check (kind in ('email', 'domain')),
  reason text,
  created_at timestamptz not null default now()
);
create unique index suppression_uniq on suppression_list (tenant_id, kind, value);

create table events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  lead_id uuid,
  kind text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index events_created_idx on events (created_at desc);
