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
  daily_send_limit, status, created_at`;

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
