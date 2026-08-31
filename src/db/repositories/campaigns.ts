import type { Db } from "../port.js";
import type { Campaign } from "../types.js";

export interface NovaCampanha {
  tenantId: string;
  name: string;
  nicheDescription: string;
  offerDescription: string;
  schedulingLink: string;
  senderFirstName: string;
  tone?: string;
  dailySendLimit?: number;
}

const COLUNAS = `id, tenant_id, name, niche_description, filters,
  offer_description, tone, scheduling_link, sender_first_name,
  daily_send_limit, send_mode, status, created_at`;

export async function criarCampanha(
  db: Db,
  input: NovaCampanha,
): Promise<Campaign> {
  const { rows } = await db.query<Campaign>(
    `insert into campaigns
       (tenant_id, name, niche_description, offer_description,
        scheduling_link, sender_first_name, tone, daily_send_limit)
     values ($1, $2, $3, $4, $5, $6,
             coalesce($7, 'consultivo, direto, sem jargão'),
             coalesce($8, 20))
     returning ${COLUNAS}`,
    [
      input.tenantId,
      input.name,
      input.nicheDescription,
      input.offerDescription,
      input.schedulingLink,
      input.senderFirstName,
      input.tone ?? null,
      input.dailySendLimit ?? null,
    ],
  );
  return rows[0]!;
}

export async function buscarCampanha(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Campaign | null> {
  const { rows } = await db.query<Campaign>(
    `select ${COLUNAS} from campaigns where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

export async function salvarFiltros(
  db: Db,
  tenantId: string,
  id: string,
  filtros: unknown,
): Promise<void> {
  await db.query(
    `update campaigns set filters = $3 where tenant_id = $1 and id = $2`,
    [tenantId, id, JSON.stringify(filtros)],
  );
}

export async function listarCampanhasAtivas(
  db: Db,
  tenantId: string,
): Promise<Campaign[]> {
  const { rows } = await db.query<Campaign>(
    `select ${COLUNAS} from campaigns
     where tenant_id = $1 and status = 'active'
     order by created_at`,
    [tenantId],
  );
  return rows;
}

/**
 * Conta o que interessa ao disjuntor de bounce.
 *
 * "Enviado" é mensagem de saída que não é sombra: um e-mail que nunca saiu não
 * pode ter dado bounce, e contá-lo diluiria a taxa. O `::int` é obrigatório —
 * `count(*)` volta `number` no PGlite e **string** no node-pg, e sem o cast o
 * teste passaria enquanto a produção comparia string com número.
 */
export async function contarEnviosEBounces(
  db: Db,
  tenantId: string,
  campaignId: string,
): Promise<{ enviados: number; bounces: number }> {
  const { rows } = await db.query<{ enviados: number; bounces: number }>(
    `select
       (select count(*)::int from messages m
          join leads l on l.id = m.lead_id
         where m.tenant_id = $1 and l.campaign_id = $2
           and m.direction = 'outbound' and m.shadow = false) as enviados,
       (select count(*)::int from leads
         where tenant_id = $1 and campaign_id = $2
           and bounced_at is not null) as bounces`,
    [tenantId, campaignId],
  );
  return { enviados: rows[0]!.enviados, bounces: rows[0]!.bounces };
}

/** Idempotente: pausar uma campanha já pausada não é erro. */
export async function pausarCampanha(
  db: Db,
  tenantId: string,
  campaignId: string,
  motivo: string,
): Promise<void> {
  await db.query(
    `update campaigns set status = 'paused'
     where tenant_id = $1 and id = $2`,
    [tenantId, campaignId],
  );
  await db.query(
    `insert into events (tenant_id, kind, payload)
     values ($1, 'campanha_pausada', $2)`,
    [tenantId, JSON.stringify({ campaignId, motivo })],
  );
}

export async function definirModoDeEnvio(
  db: Db,
  tenantId: string,
  campaignId: string,
  modo: "shadow" | "live",
): Promise<void> {
  await db.query(
    `update campaigns set send_mode = $3 where tenant_id = $1 and id = $2`,
    [tenantId, campaignId, modo],
  );
}
