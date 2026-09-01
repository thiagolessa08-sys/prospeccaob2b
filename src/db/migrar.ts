/**
 * Aplica o schema no banco apontado por DATABASE_URL.
 *
 * Existe porque um Postgres novo (Railway, RDS, local) nasce vazio, e o app
 * sobe normalmente contra um banco sem tabela nenhuma — o pool do `pg` só
 * conecta na primeira consulta, então a falha só apareceria na primeira
 * chamada de rota, longe da causa. Foi exatamente o que aconteceu no
 * primeiro deploy: `/saude` respondia 200 e `/campaigns/ativas` dava 500.
 *
 *   DATABASE_URL=... npm run db:migrate     (local)
 *
 * Vive em `src/` — e não em `scripts/` — para ser compilado junto e poder
 * rodar antes do servidor no start do Railway, onde a DATABASE_URL já está
 * no ambiente. Assim ninguém precisa passar credencial de banco à mão.
 *
 * Sai limpo quando o schema já existe, porque roda a cada deploy. A checagem
 * é grosseira de propósito (existe a tabela `tenants`?): com uma migration
 * só, um controle de versão de migrations seria cerimônia sem uso. Ao
 * acrescentar a segunda, troque isto por uma ferramenta de verdade em vez de
 * empilhar checagens.
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
