/**
 * Aplica as migrations pendentes no banco apontado por DATABASE_URL.
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
 * Roda a cada deploy e sai limpo quando não há nada pendente. Qual migration
 * já rodou é decidido por `schema_migrations` (ver `migrations.ts`), e não
 * mais por "a tabela tenants existe?" — aquela checagem grosseira bastava
 * enquanto havia uma migration só, e não sabe o que fazer com a segunda.
 */
import pg from "pg";
import { CAMINHO_DAS_MIGRATIONS } from "./caminho-migration.js";
import { listarMigrations, aplicarMigrations, type Migration } from "./migrations.js";
import { semSegredos } from "../config/redigir.js";
import { UUID_DO_POSTGRES } from "../config/env.js";

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
 * Lê os .sql ANTES de conectar.
 *
 * Não é detalhe de ordem: um caminho errado, ou um arquivo com nome fora da
 * convenção, passa a falhar sem abrir conexão nenhuma — o que torna o erro
 * reproduzível localmente sem banco. Foi justamente o que faltou para pegar o
 * `../` vs `../../` antes do deploy.
 */
let migrations: Migration[];
try {
  migrations = listarMigrations(CAMINHO_DAS_MIGRATIONS);
} catch (erro) {
  console.error(
    `Não foi possível ler as migrations em ${CAMINHO_DAS_MIGRATIONS}: ` +
      (erro instanceof Error ? erro.message : String(erro)),
  );
  process.exit(1);
}
if (migrations.length === 0) {
  console.error(`Nenhuma migration encontrada em ${CAMINHO_DAS_MIGRATIONS}.`);
  process.exit(1);
}

/**
 * Também antes de conectar, pelo mesmo motivo: um TENANT_ID fora do formato
 * uuid não tem conserto do lado do banco, e descobrir isso depois de abrir
 * conexão só atrasa a mensagem que resolve o problema.
 */
const tenantId = process.env.TENANT_ID?.trim();
if (!tenantId) {
  console.error("TENANT_ID não definida — sem ela não há tenant para criar.");
  process.exit(1);
}
if (!UUID_DO_POSTGRES.test(tenantId)) {
  console.error(
    `TENANT_ID não é um UUID válido: "${tenantId}". A coluna tenant_id é uuid no Postgres.`,
  );
  process.exit(1);
}

console.log(`Conectando em ${alvo.hostname}:${alvo.port || 5432}${alvo.pathname}`);

// `Client`, e não `Pool`: `aplicarMigrations` abre transação por consulta
// comum, e num pool o `begin` poderia sair por uma conexão e o DDL por outra.
const cliente = new pg.Client({ connectionString: url });

try {
  await cliente.connect();

  const resultado = await aplicarMigrations(cliente, migrations);

  if (resultado.adotadas.length) {
    console.log(
      `Banco existente adotado: ${resultado.adotadas.join(", ")} registrada(s) sem reaplicar.`,
    );
  }
  if (resultado.jaAplicadas.length) {
    console.log(`Já aplicadas: ${resultado.jaAplicadas.join(", ")}`);
  }
  if (resultado.aplicadas.length) {
    console.log(`Aplicadas agora: ${resultado.aplicadas.join(", ")}`);
  } else {
    console.log("Nenhuma migration pendente.");
  }

  /**
   * Cria a linha do tenant, sempre — inclusive quando o schema já existia.
   *
   * O schema cria as tabelas mas não popula nenhuma, e `campaigns.tenant_id`
   * referencia `tenants(id)`. Sem esta linha, um deploy novo sobe inteiro e
   * só falha em `POST /campaigns`, com violação de chave estrangeira: o
   * TENANT_ID do ambiente aponta para um tenant que não existe. Fica fora do
   * .sql porque o id vem do ambiente, não do schema.
   */
  const { rowCount } = await cliente.query(
    `insert into tenants (id, name) values ($1, $2) on conflict (id) do nothing`,
    [tenantId, "Tenant principal"],
  );
  console.log(
    rowCount ? `Tenant ${tenantId} criado.` : `Tenant ${tenantId} já existia.`,
  );
} catch (erro) {
  const bruto = erro instanceof Error ? erro.message : String(erro);
  console.error(`Falhou: ${semSegredos(bruto)}`);
  process.exit(1);
} finally {
  await cliente.end();
}
