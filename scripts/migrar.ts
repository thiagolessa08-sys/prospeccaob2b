/**
 * Aplica o schema no banco apontado por DATABASE_URL.
 *
 * Existe porque um Postgres novo (Railway, RDS, local) nasce vazio, e o app
 * sobe normalmente contra um banco sem tabela nenhuma — o pool do `pg` só
 * conecta na primeira consulta, então a falha só apareceria na primeira
 * chamada de rota, longe da causa.
 *
 *   DATABASE_URL=... npm run db:migrate
 *
 * Não é idempotente de propósito: rodar duas vezes falha no `create table`
 * já existente, em vez de mascarar com IF NOT EXISTS uma migration que
 * mudou de conteúdo desde a primeira aplicação.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(aqui, "../supabase/migrations/0001_initial_schema.sql");

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}

const cliente = new pg.Client({ connectionString: url });

try {
  await cliente.connect();

  const { rows } = await cliente.query<{ existe: boolean }>(
    `select to_regclass('public.tenants') is not null as existe`,
  );
  if (rows[0]?.existe) {
    console.log("Schema já aplicado (tabela `tenants` existe). Nada a fazer.");
    process.exit(0);
  }

  await cliente.query(readFileSync(MIGRATION, "utf8"));
  console.log("Schema aplicado.");

  const { rows: tabelas } = await cliente.query<{ nome: string }>(
    `select tablename as nome from pg_tables where schemaname = 'public' order by tablename`,
  );
  console.log(`Tabelas: ${tabelas.map((t) => t.nome).join(", ")}`);
} catch (erro) {
  console.error(`Falhou: ${erro instanceof Error ? erro.message : erro}`);
  process.exit(1);
} finally {
  await cliente.end();
}
