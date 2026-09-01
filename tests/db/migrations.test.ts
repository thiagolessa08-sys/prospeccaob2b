import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../src/db/port.js";
import { CAMINHO_DAS_MIGRATIONS } from "../../src/db/caminho-migration.js";
import { aplicarMigrations, type Migration } from "../../src/db/migrations.js";

/**
 * Banco cru a cada teste, sem o helper `subirBanco`: é justamente o migrador
 * que está sob teste, e o helper já aplica as migrations por conta própria.
 */
let pglite: PGlite;
let db: Db;

beforeEach(async () => {
  pglite = new PGlite();
  db = pglite;
});

afterEach(async () => {
  await pglite.close();
});

const SCHEMA_INICIAL: Migration = {
  versao: "0001_initial_schema.sql",
  sql: readFileSync(join(CAMINHO_DAS_MIGRATIONS, "0001_initial_schema.sql"), "utf8"),
};

const SEGUNDA: Migration = {
  versao: "0002_exemplo.sql",
  sql: `create table exemplo_da_segunda (id int primary key);`,
};

/**
 * O PGlite precisa de `exec` para .sql com várias instruções — `query()` lá é
 * protocolo estendido e aceita uma só. Em produção o node-pg não precisa
 * disso, e é justamente essa divergência que a opção existe para cobrir.
 */
function aplicar(migrations: Migration[]) {
  return aplicarMigrations(db, migrations, {
    executarSql: (sql) => pglite.exec(sql),
  });
}

async function versoesRegistradas(): Promise<string[]> {
  const { rows } = await db.query<{ version: string }>(
    `select version from schema_migrations order by version`,
  );
  return rows.map((r) => r.version);
}

async function tabelaExiste(nome: string): Promise<boolean> {
  const { rows } = await db.query<{ existe: boolean }>(
    `select to_regclass($1) is not null as existe`,
    ["public." + nome],
  );
  return rows[0]?.existe === true;
}

describe("aplicarMigrations num banco vazio", () => {
  it("aplica e registra", async () => {
    const r = await aplicar([SCHEMA_INICIAL]);

    expect(r.aplicadas).toEqual(["0001_initial_schema.sql"]);
    expect(r.jaAplicadas).toEqual([]);
    expect(r.adotadas).toEqual([]);
    expect(await tabelaExiste("tenants")).toBe(true);
    expect(await versoesRegistradas()).toEqual(["0001_initial_schema.sql"]);
  });

  it("rodar de novo não reaplica nada", async () => {
    await aplicar([SCHEMA_INICIAL]);
    const r = await aplicar([SCHEMA_INICIAL]);

    // Reaplicar morreria em `type "lead_stage" already exists`. O teste
    // existe porque isto roda a cada deploy do Railway.
    expect(r.aplicadas).toEqual([]);
    expect(r.jaAplicadas).toEqual(["0001_initial_schema.sql"]);
  });

  it("aplica na ordem da lista", async () => {
    const r = await aplicar([SCHEMA_INICIAL, SEGUNDA]);

    expect(r.aplicadas).toEqual(["0001_initial_schema.sql", "0002_exemplo.sql"]);
    expect(await tabelaExiste("exemplo_da_segunda")).toBe(true);
  });

  it("aplica só a pendente quando a primeira já rodou", async () => {
    await aplicar([SCHEMA_INICIAL]);
    const r = await aplicar([SCHEMA_INICIAL, SEGUNDA]);

    expect(r.jaAplicadas).toEqual(["0001_initial_schema.sql"]);
    expect(r.aplicadas).toEqual(["0002_exemplo.sql"]);
  });
});

describe("adoção do banco criado pelo migrador antigo", () => {
  it("registra a primeira sem reaplicar, quando `tenants` já existe", async () => {
    // Simula produção: o migrador anterior aplicava o .sql e não registrava
    // nada. Sem a adoção, a primeira migration seria reaplicada e o deploy de
    // quem já está no ar morreria em "already exists".
    await pglite.exec(SCHEMA_INICIAL.sql);
    expect(await tabelaExiste("schema_migrations")).toBe(false);

    const r = await aplicar([SCHEMA_INICIAL, SEGUNDA]);

    expect(r.adotadas).toEqual(["0001_initial_schema.sql"]);
    expect(r.aplicadas).toEqual(["0002_exemplo.sql"]);
    expect(await versoesRegistradas()).toEqual([
      "0001_initial_schema.sql",
      "0002_exemplo.sql",
    ]);
  });

  it("não adota nada num banco realmente vazio", async () => {
    const r = await aplicar([SCHEMA_INICIAL]);
    expect(r.adotadas).toEqual([]);
    expect(r.aplicadas).toEqual(["0001_initial_schema.sql"]);
  });

  it("adota só a primeira, nunca as seguintes", async () => {
    // O migrador antigo aplicava exatamente uma migration. Adotar a segunda
    // marcaria como feita uma alteração que nunca chegou ao banco.
    await pglite.exec(SCHEMA_INICIAL.sql);

    const r = await aplicar([SCHEMA_INICIAL, SEGUNDA]);

    expect(r.adotadas).toEqual(["0001_initial_schema.sql"]);
    expect(await tabelaExiste("exemplo_da_segunda")).toBe(true);
  });
});

describe("falha no meio", () => {
  it("desfaz a que falhou e mantém as anteriores registradas", async () => {
    const quebrada: Migration = {
      versao: "0002_quebrada.sql",
      sql: `create table meio_certo (id int primary key);
            create table meio_errado (id int primary key, x nao_existe_esse_tipo);`,
    };

    await expect(aplicar([SCHEMA_INICIAL, quebrada])).rejects.toThrow(
      /0002_quebrada\.sql/,
    );

    // A primeira continua registrada — reexecutar depois do conserto retoma
    // daqui, em vez de tentar tudo de novo.
    expect(await versoesRegistradas()).toEqual(["0001_initial_schema.sql"]);
    // E a tabela criada antes do erro, dentro da mesma migration, sumiu com o
    // rollback: uma migration é tudo ou nada.
    expect(await tabelaExiste("meio_certo")).toBe(false);
  });
});
