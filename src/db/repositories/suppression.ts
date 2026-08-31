import type { Db } from "../port.js";
import type { SuppressionRule } from "../../domain/suppression.js";

export async function carregarRegrasDeSupressao(
  db: Db,
  tenantId: string,
): Promise<SuppressionRule[]> {
  const { rows } = await db.query<{ kind: "email" | "domain"; value: string }>(
    `select kind, value from suppression_list where tenant_id = $1`,
    [tenantId],
  );
  return rows.map((r) => ({ kind: r.kind, value: r.value }));
}

/** Idempotente: a mesma regra pode ser adicionada quantas vezes for. */
export async function adicionarSupressao(
  db: Db,
  tenantId: string,
  regra: SuppressionRule,
  motivo: string,
): Promise<void> {
  await db.query(
    `insert into suppression_list (tenant_id, kind, value, reason)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [tenantId, regra.kind, regra.value, motivo],
  );
}
