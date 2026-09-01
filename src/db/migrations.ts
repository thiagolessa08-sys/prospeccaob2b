import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./port.js";

/**
 * Controle de versão das migrations.
 *
 * O migrador anterior perguntava "a tabela `tenants` existe?" e, se existisse,
 * não fazia nada. Com uma migration só, aquilo bastava — e o comentário de lá
 * já avisava que a segunda exigiria uma ferramenta de verdade. Esta é ela.
 *
 * Sem isto, toda coluna nova precisaria de `alter table` manual no Supabase, e
 * o banco de produção iria divergindo do `.sql` do repositório sem que nada
 * apontasse a diferença.
 */
export interface Migration {
  /** O nome do arquivo, que é também a chave em `schema_migrations`. */
  versao: string;
  sql: string;
}

/**
 * `0001_nome.sql`. O prefixo numérico não é enfeite: a ordem de aplicação é a
 * ordem alfabética dos nomes, e sem largura fixa `10_x` viria antes de `9_x`.
 */
const NOME_VALIDO = /^\d{4}_[\w-]+\.sql$/;

/**
 * Lê as migrations do diretório, em ordem.
 *
 * Um arquivo fora da convenção derruba a leitura em vez de ser ignorado: uma
 * migration silenciosamente pulada é pior que um erro no boot — o app subiria
 * contra um schema incompleto e falharia longe da causa.
 */
export function listarMigrations(diretorio: string): Migration[] {
  const arquivos = readdirSync(diretorio)
    .filter((nome) => nome.endsWith(".sql"))
    .sort();

  return arquivos.map((nome) => {
    if (!NOME_VALIDO.test(nome)) {
      throw new Error(
        `Migration com nome fora da convenção: "${nome}". ` +
          `Esperado NNNN_descricao.sql, com quatro dígitos.`,
      );
    }
    return { versao: nome, sql: readFileSync(join(diretorio, nome), "utf8") };
  });
}

export interface ResultadoDaMigracao {
  /** Rodaram agora. */
  aplicadas: string[];
  /** Já constavam como aplicadas. */
  jaAplicadas: string[];
  /** Registradas sem rodar, por já estarem no banco desde o migrador antigo. */
  adotadas: string[];
}

export interface OpcoesDaMigracao {
  /**
   * Como rodar um arquivo .sql inteiro.
   *
   * Existe porque aqui o porte `Db` vaza, e de um jeito que só apareceria em
   * tempo de execução. Um .sql de schema tem várias instruções, e:
   *
   * - o node-pg, quando `query(texto)` é chamado **sem parâmetros**, usa o
   *   protocolo simples, que aceita várias instruções de uma vez;
   * - o PGlite usa o protocolo estendido em `query()`, que aceita **uma só** —
   *   por isso ele tem `exec()` à parte.
   *
   * O padrão serve à produção (`pg.Client`). O teste passa `exec` do PGlite.
   */
  executarSql?: (sql: string) => Promise<unknown>;
}

/**
 * Aplica o que falta e registra o que aplicou.
 *
 * Precisa de uma **conexão única** (`pg.Client`, PGlite) — nunca um `pg.Pool`.
 * O `begin`/`commit` viaja como consulta comum pelo porte `Db`, e num pool
 * cada consulta pode sair por uma conexão diferente, o que faria a transação
 * abrir numa e o DDL rodar em outra, fora dela.
 */
export async function aplicarMigrations(
  db: Db,
  migrations: readonly Migration[],
  opcoes: OpcoesDaMigracao = {},
): Promise<ResultadoDaMigracao> {
  const executarSql = opcoes.executarSql ?? ((sql: string) => db.query(sql));
  await db.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const { rows: registradas } = await db.query<{ version: string }>(
    `select version from schema_migrations`,
  );
  const jaTem = new Set(registradas.map((r) => r.version));

  const resultado: ResultadoDaMigracao = {
    aplicadas: [],
    jaAplicadas: [],
    adotadas: [],
  };

  /**
   * Adoção do banco que veio do migrador antigo.
   *
   * Aquele migrador aplicava exatamente a primeira migration e não registrava
   * nada. Então um banco com `tenants` mas sem nenhuma linha em
   * `schema_migrations` está, por construção, na primeira versão — e só nela.
   * Sem este passo, a primeira migration seria reaplicada e morreria em
   * `type "lead_stage" already exists`, derrubando o deploy de quem já está
   * em produção.
   */
  if (jaTem.size === 0 && migrations.length > 0) {
    const { rows } = await db.query<{ existe: boolean }>(
      `select to_regclass('public.tenants') is not null as existe`,
    );
    if (rows[0]?.existe) {
      const primeira = migrations[0]!.versao;
      await db.query(`insert into schema_migrations (version) values ($1)`, [
        primeira,
      ]);
      jaTem.add(primeira);
      resultado.adotadas.push(primeira);
    }
  }

  for (const migration of migrations) {
    if (jaTem.has(migration.versao)) {
      if (!resultado.adotadas.includes(migration.versao)) {
        resultado.jaAplicadas.push(migration.versao);
      }
      continue;
    }

    // Uma transação por migration, e não uma para todas: a que falha desfaz
    // só a si mesma, e as anteriores continuam registradas. Reexecutar depois
    // do conserto retoma de onde parou, em vez de tentar tudo de novo.
    await db.query("begin");
    try {
      await executarSql(migration.sql);
      await db.query(`insert into schema_migrations (version) values ($1)`, [
        migration.versao,
      ]);
      await db.query("commit");
    } catch (erro) {
      await db.query("rollback").catch(() => {});
      throw new Error(
        `Migration ${migration.versao} falhou: ` +
          (erro instanceof Error ? erro.message : String(erro)),
      );
    }
    resultado.aplicadas.push(migration.versao);
  }

  return resultado;
}
