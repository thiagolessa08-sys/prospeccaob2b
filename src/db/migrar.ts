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
import { CAMINHO_DA_MIGRATION } from "./caminho-migration.js";

const MIGRATION = CAMINHO_DA_MIGRATION;

/**
 * Nunca deixe a connection string chegar a um log: ela carrega a senha do
 * banco em texto claro. O primeiro deploy no Railway imprimiu a senha do
 * Postgres onze vezes nos logs, porque o erro do `pg` embute a string inteira
 * na mensagem — mesma disciplina que `urlSegura` em src/http/fetch-json.ts já
 * aplica às chaves de API.
 */
function semSegredo(texto: string, url: string): string {
  let limpo = texto.split(url).join("[DATABASE_URL]");
  try {
    const senha = new URL(url).password;
    if (senha) limpo = limpo.split(senha).join("***");
  } catch {
    // URL malformada não tem senha isolável; o split acima já cobriu o caso
    // de a string inteira aparecer na mensagem.
  }
  return limpo;
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}

/**
 * Valida o formato antes de conectar.
 *
 * Sem isto, uma DATABASE_URL malformada só se manifesta como
 * `database "..." does not exist` — que manda procurar o problema no banco,
 * quando ele está na variável de ambiente. Aconteceu de verdade: duas
 * connection strings coladas viraram um "nome de banco" gigante.
 */
let alvo: URL;
try {
  alvo = new URL(url);
} catch {
  console.error(
    "DATABASE_URL não é uma URL válida. Esperado: postgresql://usuario:senha@host:porta/banco",
  );
  process.exit(1);
}
if (!/^postgres(ql)?:$/.test(alvo.protocol)) {
  console.error(
    `DATABASE_URL tem protocolo "${alvo.protocol}", esperado "postgresql:".`,
  );
  process.exit(1);
}
if (url.lastIndexOf("postgres://") > 0 || url.lastIndexOf("postgresql://") > 0) {
  console.error(
    "DATABASE_URL parece conter DUAS connection strings emendadas. " +
      "No Railway o valor deve ser apenas a referência ${{Postgres.DATABASE_URL}}.",
  );
  process.exit(1);
}

/**
 * Lê o .sql ANTES de conectar.
 *
 * Não é detalhe de ordem: um caminho errado passa a falhar sem abrir conexão
 * nenhuma, o que torna o erro reproduzível localmente sem banco — foi
 * justamente o que faltou para pegar o `../` vs `../../` antes do deploy.
 */
let sql: string;
try {
  sql = readFileSync(MIGRATION, "utf8");
} catch {
  console.error(`Migration não encontrada em ${MIGRATION}`);
  process.exit(1);
}

console.log(`Conectando em ${alvo.hostname}:${alvo.port || 5432}${alvo.pathname}`);
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

  await cliente.query(sql);
  console.log("Schema aplicado.");

  const { rows: tabelas } = await cliente.query<{ nome: string }>(
    `select tablename as nome from pg_tables where schemaname = 'public' order by tablename`,
  );
  console.log(`Tabelas: ${tabelas.map((t) => t.nome).join(", ")}`);
} catch (erro) {
  const bruto = erro instanceof Error ? erro.message : String(erro);
  console.error(`Falhou: ${semSegredo(bruto, url)}`);
  process.exit(1);
} finally {
  await cliente.end();
}
