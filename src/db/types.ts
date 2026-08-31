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
  sender_first_name: string;
  scheduling_link: string;
  daily_send_limit: number;
  status: "active" | "paused" | "archived";
  created_at: Date;
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
  created_at: Date;
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
  resume_at: Date | null;
  needs_human: boolean;
  handoff_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Message {
  id: string;
  tenant_id: string;
  lead_id: string;
  direction: "outbound" | "inbound";
  subject: string | null;
  body: string;
  intent: ReplyIntent | null;
  /**
   * String, não número: a coluna é `numeric`, e nem o `pg` nem o `PGlite`
   * convertem `numeric` para `number` — deliberadamente, para não perder
   * precisão em ponto flutuante. Quem for comparar com um limiar precisa
   * chamar `Number()` antes; declarar `number` aqui deixaria
   * `decideNextAction({ confidence: "0.91" })` compilar em silêncio.
   */
  confidence: string | null;
  ai_reasoning: string | null;
  external_id: string | null;
  created_at: Date;
}

export interface SuppressionEntry {
  id: string;
  tenant_id: string;
  value: string;
  kind: "email" | "domain";
  reason: string | null;
  created_at: Date;
}
