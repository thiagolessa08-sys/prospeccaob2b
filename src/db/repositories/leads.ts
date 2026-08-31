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

/**
 * Cria o lead exigindo que a empresa seja do mesmo tenant.
 *
 * `tenant_id` e `company_id` são chaves estrangeiras independentes: o esquema
 * aceitaria de bom grado um lead do tenant A apontando para uma empresa do
 * tenant B. As leituras filtram por tenant e não veriam a linha, então o
 * estrago seria dado invisível — dado órfão hoje, vazamento no dia em que
 * alguma consulta juntar por `company_id`. O `where exists` faz o próprio
 * banco recusar a combinação, sem transação e sem uma segunda ida ao servidor.
 */
export async function criarLead(db: Db, input: NovoLead): Promise<Lead> {
  const { rows } = await db.query<Lead>(
    `insert into leads
       (tenant_id, campaign_id, company_id, full_name, role_title,
        email, email_verified)
     select $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
            $7::boolean
     where exists (
       select 1 from companies where id = $3 and tenant_id = $1
     )
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
  if (!rows[0]) {
    throw new Error(
      `Empresa ${input.companyId} não pertence ao tenant ${input.tenantId}: ` +
        `um lead não pode cruzar tenants.`,
    );
  }
  return rows[0];
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
 *
 * O UPDATE é condicionado ao estágio que acabou de ser lido e validado
 * (compare-and-swap). Sem isso, ler-validar-escrever é uma corrida: um webhook
 * de resposta e a varredura de follow-up podem ler `enriched` ao mesmo tempo,
 * ambos aprovar, e ambos escrever — deixando o lead num estágio que o funil
 * nunca autorizou. É exatamente o instante em que os leads com `resume_at`
 * vencido acordam. Zero linhas de volta significa que outro fluxo moveu o lead
 * primeiro; lançamos, e quem chamou decide se relê e tenta de novo.
 *
 * O teste não enxerga essa corrida por construção: o PGlite é uma única
 * conexão serializada, enquanto o `pg.Pool` distribui cinco.
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
     where tenant_id = $1 and id = $2 and stage = $8
     returning ${COLUNAS}`,
    [
      tenantId,
      id,
      para,
      extras.discardReason ?? null,
      extras.handoffReason ?? null,
      extras.needsHuman ?? null,
      extras.resumeAt ?? null,
      atual.stage,
    ],
  );
  if (!rows[0]) {
    throw new Error(
      `Lead ${id} mudou de estágio ao mesmo tempo: esperava ${atual.stage} ` +
        `para aplicar ${atual.stage} -> ${para}, mas outro fluxo moveu antes.`,
    );
  }
  return rows[0];
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
