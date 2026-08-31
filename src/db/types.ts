export const LEAD_STAGES = [
  "discovered",
  "enriched",
  "contacted",
  "in_conversation",
  "meeting_booked",
  "discarded",
  "error",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const REPLY_INTENTS = [
  "interested",
  "question_or_objection",
  "not_now",
  "no",
  "opt_out",
  "out_of_scope",
] as const;

export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  niche_description: string;
  filters: unknown | null;
  offer_description: string;
  tone: string;
  scheduling_link: string;
  daily_send_limit: number;
  status: "active" | "paused" | "archived";
  created_at: string;
}

export interface Company {
  id: string;
  tenant_id: string;
  campaign_id: string;
  cnpj: string | null;
  legal_name: string;
  trade_name: string | null;
  website: string | null;
  city: string | null;
  uf: string | null;
  employee_count: number | null;
  summary: string | null;
  source: string;
  enrichment_status: "pending" | "enriched" | "failed";
  created_at: string;
}

export interface Lead {
  id: string;
  tenant_id: string;
  campaign_id: string;
  company_id: string;
  full_name: string | null;
  role_title: string | null;
  email: string;
  email_verified: boolean;
  stage: LeadStage;
  discard_reason: string | null;
  exchange_count: number;
  resume_at: string | null;
  needs_human: boolean;
  handoff_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  tenant_id: string;
  lead_id: string;
  direction: "outbound" | "inbound";
  subject: string | null;
  body: string;
  intent: ReplyIntent | null;
  confidence: number | null;
  ai_reasoning: string | null;
  external_id: string | null;
  created_at: string;
}

export interface SuppressionEntry {
  id: string;
  tenant_id: string;
  value: string;
  kind: "email" | "domain";
  reason: string | null;
  created_at: string;
}
