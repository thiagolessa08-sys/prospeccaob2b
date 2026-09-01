import type { Db } from "../port.js";
import type { Campaign } from "../types.js";
import { registrarEvento } from "./events.js";

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
         where m.tenant_id = $1 and l.tenant_id = $1 and l.campaign_id = $2
           and m.direction = 'outbound' and m.shadow = false) as enviados,
       (select count(*)::int from leads
         where tenant_id = $1 and campaign_id = $2
           and bounced_at is not null) as bounces`,
    [tenantId, campaignId],
  );
  return { enviados: rows[0]!.enviados, bounces: rows[0]!.bounces };
}

/** Mensagens de verdade que já saíram hoje nesta campanha. */
export async function contarEnviosDeHoje(
  db: Db,
  tenantId: string,
  campaignId: string,
): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    `select count(*)::int as total from messages m
       join leads l on l.id = m.lead_id
      where m.tenant_id = $1 and l.tenant_id = $1 and l.campaign_id = $2
        and m.direction = 'outbound' and m.shadow = false
        and m.created_at >= date_trunc('day', now())`,
    [tenantId, campaignId],
  );
  return rows[0]!.total;
}

/**
 * Pausa a campanha. Idempotente: pausar uma já pausada não é erro.
 *
 * O evento só é registrado quando a pausa de fato aconteceu. O disjuntor é
 * reavaliado a cada lote, então sem a guarda `status <> 'paused'` uma campanha
 * já pausada geraria um evento novo a cada tentativa — afogando, no meio do
 * ruído, o registro que de fato importa: o momento em que ela foi pausada.
 */
export async function pausarCampanha(
  db: Db,
  tenantId: string,
  campaignId: string,
  motivo: string,
): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `update campaigns set status = 'paused'
     where tenant_id = $1 and id = $2 and status <> 'paused'
     returning id`,
    [tenantId, campaignId],
  );

  if (rows.length > 0) {
    await registrarEvento(db, {
      tenantId,
      leadId: null,
      kind: "campanha_pausada",
      payload: { campaignId, motivo },
    });
  }
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

/**
 * Lista todas as campanhas do tenant, ativas ou não.
 *
 * Função à parte de `listarCampanhasAtivas` de propósito: aquela existe para o
 * n8n decidir o que disparar, e uma campanha pausada ali seria um disparo
 * indevido. O painel é o oposto — quem olha precisa justamente ver a pausada e
 * a arquivada, senão a campanha some da tela sem explicação no dia em que
 * alguém a pausa.
 */
export async function listarCampanhas(
  db: Db,
  tenantId: string,
): Promise<Campaign[]> {
  const { rows } = await db.query<Campaign>(
    `select ${COLUNAS} from campaigns
     where tenant_id = $1
     order by created_at desc`,
    [tenantId],
  );
  return rows;
}
