import type { Db } from "../port.js";

export interface NovoEvento {
  tenantId: string | null;
  leadId: string | null;
  kind: string;
  payload?: unknown;
}

/**
 * Trilha de auditoria. `tenant_id` e `lead_id` são anuláveis de propósito:
 * falhas que acontecem antes de resolver o tenant também precisam ser
 * registradas.
 */
export async function registrarEvento(
  db: Db,
  input: NovoEvento,
): Promise<void> {
  await db.query(
    `insert into events (tenant_id, lead_id, kind, payload)
     values ($1, $2, $3, $4)`,
    [
      input.tenantId,
      input.leadId,
      input.kind,
      input.payload === undefined ? null : JSON.stringify(input.payload),
    ],
  );
}

export interface EventoDoLead {
  id: string;
  kind: string;
  payload: unknown | null;
  created_at: Date;
}

/**
 * Trilha de auditoria de um lead, do mais recente para o mais antigo.
 *
 * Filtra por `tenant_id` **e** `lead_id`. O `tenant_id` de `events` é anulável
 * — falhas anteriores à resolução do tenant também são registradas — e um
 * `where lead_id = $1` sozinho devolveria eventos de qualquer dono que
 * apontasse para esse id.
 */
export async function listarEventosDoLead(
  db: Db,
  tenantId: string,
  leadId: string,
  limite: number,
): Promise<EventoDoLead[]> {
  const { rows } = await db.query<EventoDoLead>(
    `select id, kind, payload, created_at
     from events
     where tenant_id = $1 and lead_id = $2
     order by created_at desc
     limit $3`,
    [tenantId, leadId, limite],
  );
  return rows;
}
