import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "../../src/db/port.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const CAMINHO_MIGRATION = join(
  aqui,
  "../../supabase/migrations/0001_initial_schema.sql",
);

export const TENANT_ID = "11111111-1111-1111-1111-111111111111";
export const CAMPANHA_ID = "22222222-2222-2222-2222-222222222222";

export interface BancoDeTeste {
  db: Db;
  tenantId: string;
  campaignId: string;
  encerrar(): Promise<void>;
}

/**
 * Sobe um Postgres limpo em memória com a migration real aplicada, mais um
 * tenant e uma campanha de teste.
 *
 * Leva ~2,3 s. Chame uma vez por arquivo de teste (`beforeAll`), nunca por
 * teste — e isole os casos entre si usando dados diferentes, não recriando o
 * banco.
 */
export async function subirBanco(): Promise<BancoDeTeste> {
  const pglite = new PGlite();
  await pglite.exec(readFileSync(CAMINHO_MIGRATION, "utf8"));

  const db = pglite as unknown as Db;

  await db.query(`insert into tenants (id, name) values ($1, $2)`, [
    TENANT_ID,
    "SQL Tech",
  ]);
  await db.query(
    `insert into campaigns
       (id, tenant_id, name, niche_description, offer_description,
        scheduling_link, sender_first_name)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      CAMPANHA_ID,
      TENANT_ID,
      "Campanha de teste",
      "indústrias de alimentos em SC",
      "Consultoria de dados e BI",
      "https://cal.com/thiago/30min",
      "Thiago",
    ],
  );

  return {
    db,
    tenantId: TENANT_ID,
    campaignId: CAMPANHA_ID,
    encerrar: () => pglite.close(),
  };
}
