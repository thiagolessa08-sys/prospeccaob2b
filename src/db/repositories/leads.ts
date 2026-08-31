import type { Db } from "../port.js";
import type { Lead, LeadStage } from "../types.js";
import { assertTransition } from "../../domain/stages.js";

export interface NovoLead {
  tenantId: string;
  campaignId: string;
  companyId: string;
  fullName: string | null;
  roleTitle: string | null;
  email: string;
  emailVerified: boolean;
}

export interface ExtrasDaTransicao {
  discardReason?: string;
  handoffReason?: string;
  needsHuman?: boolean;
  resumeAt?: Date;
}

const COLUNAS = `id, tenant_id, campaign_id, company_id, full_name, role_title,
  email, email_verified, stage, discard_reason, handoff_reason, exchange_count,
  resume_at, needs_human, created_at, updated_at`;

export async function criarLead(db: Db, input: NovoLead): Promise<Lead> {
  const { rows } = await db.query<Lead>(
    `insert into leads
       (tenant_id, campaign_id, company_id, full_name, role_title,
        email, email_verified)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${COLUNAS}`,
    [
      input.tenantId,
      input.campaignId,
      input.companyId,
      input.fullName,
      input.roleTitle,
      input.email,
      input.emailVerified,
    ],
  );
  return rows[0]!;
}

export async function buscarLead(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Lead | null> {
  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/**
 * Move o lead de estágio, validando a transição antes de escrever.
 *
 * A validação usa a mesma máquina de estados do domínio (`assertTransition`),
 * então o banco nunca guarda um caminho que o funil não permite — e o lead
 * fica intacto quando a transição é recusada.
 */
export async function transicionarLead(
  db: Db,
  tenantId: string,
  id: string,
  para: LeadStage,
  extras: ExtrasDaTransicao = {},
): Promise<Lead> {
  const atual = await buscarLead(db, tenantId, id);
  if (!atual) {
    throw new Error(`Lead ${id} não encontrado no tenant ${tenantId}.`);
  }

  assertTransition(atual.stage, para);

  const { rows } = await db.query<Lead>(
    `update leads set
       stage = $3,
       discard_reason = coalesce($4, discard_reason),
       handoff_reason = coalesce($5, handoff_reason),
       needs_human = coalesce($6, needs_human),
       resume_at = coalesce($7, resume_at)
     where tenant_id = $1 and id = $2
     returning ${COLUNAS}`,
    [
      tenantId,
      id,
      para,
      extras.discardReason ?? null,
      extras.handoffReason ?? null,
      extras.needsHuman ?? null,
      extras.resumeAt ?? null,
    ],
  );
  return rows[0]!;
}

export async function incrementarTrocas(
  db: Db,
  tenantId: string,
  id: string,
): Promise<number> {
  const { rows } = await db.query<{ exchange_count: number }>(
    `update leads set exchange_count = exchange_count + 1
     where tenant_id = $1 and id = $2
     returning exchange_count`,
    [tenantId, id],
  );
  if (!rows[0]) {
    throw new Error(`Lead ${id} não encontrado no tenant ${tenantId}.`);
  }
  return rows[0].exchange_count;
}

/** Leads prontos para o primeiro contato: enriquecidos e com e-mail verificado. */
export async function listarProntosParaContato(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<Lead[]> {
  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads
     where tenant_id = $1 and campaign_id = $2
       and stage = 'enriched' and email_verified = true
     order by created_at
     limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}
