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
  -- Nome real de quem assina os e-mails. Obrigatório: sem ele o modelo inventa
  -- um nome humano, e uma mesma thread acabaria assinada por duas pessoas.
  sender_first_name text not null,
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
  handoff_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index leads_tenant_email_uniq on leads (tenant_id, lower(email));
create index leads_stage_idx on leads (tenant_id, stage);
-- Fila de repasse a humano consultada pelo painel: índice parcial, porque só
-- interessam os leads efetivamente parados esperando alguém.
create index leads_needs_human_idx on leads (tenant_id) where needs_human;
-- Varredura de "acordar leads vencidos" do Plano 2: sem este índice parcial a
-- busca por resume_at vencido seria varredura sequencial da tabela inteira.
create index leads_resume_idx
  on leads (tenant_id, resume_at) where resume_at is not null;

-- updated_at tem default now(), mas default só vale no insert: sem gatilho a
-- coluna congela no momento da criação e passa a mentir sobre o lead.
create function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger leads_set_updated_at
  before update on leads
  for each row execute function set_updated_at();

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
-- O webhook do provedor de e-mail reentrega em qualquer resposta não-2xx ou
-- timeout. Sem esta unicidade, uma reentrega criaria uma segunda mensagem de
-- entrada: nova classificação, nova réplica enviada de verdade ao lead e
-- exchange_count contado em dobro.
create unique index messages_external_uniq
  on messages (tenant_id, external_id) where external_id is not null;

create table suppression_list (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  value text not null,
  kind text not null check (kind in ('email', 'domain')),
  reason text,
  created_at timestamptz not null default now()
);
create unique index suppression_uniq on suppression_list (tenant_id, kind, value);

-- events é a única tabela sem chave estrangeira, de propósito: ela precisa
-- registrar falhas que acontecem antes de existir um tenant ou um lead
-- resolvível (erro de webhook, payload irreconhecível, busca que não achou
-- nada). Uma FK aqui faria o log falhar exatamente quando ele é mais útil.
create table events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  lead_id uuid,
  kind text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index events_created_idx on events (created_at desc);

-- Row Level Security: negar por padrão.
--
-- Tudo que mora em `public` no Supabase é exposto pela PostgREST, e a chave
-- anon é uma credencial pública que o painel web vai embarcar no navegador.
-- Sem RLS, qualquer pessoa com essa chave lê e escreve leads, mensagens e
-- lista de supressão de todos os tenants.
--
-- Habilitamos RLS sem criar nenhuma policy: nada é acessível pelas chaves
-- anon/authenticated. A chave service_role usada por src/db/client.ts ignora
-- RLS, então todo o backend continua funcionando sem alteração. O painel do
-- plano futuro acrescenta as policies com escopo por tenant.
alter table tenants enable row level security;
alter table campaigns enable row level security;
alter table companies enable row level security;
alter table leads enable row level security;
alter table messages enable row level security;
alter table suppression_list enable row level security;
alter table events enable row level security;
