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
