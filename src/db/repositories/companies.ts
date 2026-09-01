import type { Db } from "../port.js";
import type { Company } from "../types.js";

export interface NovaEmpresa {
  tenantId: string;
  campaignId: string;
  cnpj: string | null;
  legalName: string;
  tradeName: string | null;
  website: string | null;
  city: string | null;
  uf: string | null;
  employeeCount: number | null;
  summary: string | null;
  source: string;
}

const COLUNAS = `id, tenant_id, campaign_id, cnpj, legal_name, trade_name,
  website, city, uf, employee_count, summary, source, enrichment_status,
  created_at`;

/**
 * Insere o lote deixando o banco resolver a duplicidade.
 *
 * `on conflict do nothing` sobre o índice parcial de CNPJ mantém o registro
 * original e devolve menos linhas do que foram enviadas — a diferença é a
 * contagem de ignoradas. Fazer o dedup em SQL, e não em memória, é o que torna
 * a operação segura quando dois fluxos rodam ao mesmo tempo.
 *
 * O conflito é declarado no índice exato, e não `on conflict do nothing` seco:
 * `ignoradas` é derivado por subtração e vira número que um humano lê como
 * "duplicata de CNPJ". Um conflito de qualquer índice futuro seria absorvido
 * em silêncio e reportado com esse mesmo nome. O `where cnpj is not null`
 * repete o predicado do índice parcial — sem ele o Postgres recusa a instrução.
 */
export async function salvarEmpresas(
  db: Db,
  empresas: readonly NovaEmpresa[],
): Promise<{ inseridas: number; ignoradas: number }> {
  if (empresas.length === 0) return { inseridas: 0, ignoradas: 0 };

  // `tenant_id` e `campaign_id` são chaves estrangeiras independentes: o
  // esquema aceitaria uma empresa do tenant A ligada a uma campanha do tenant
  // B. Conferir antes do lote, e não linha a linha, porque na prática o lote
  // inteiro vem de uma única campanha — o laço só existe para o caso de
  // alguém misturar.
  const pares = new Map<string, { tenantId: string; campaignId: string }>();
  for (const e of empresas) {
    pares.set(`${e.tenantId}|${e.campaignId}`, {
      tenantId: e.tenantId,
      campaignId: e.campaignId,
    });
  }
  for (const par of pares.values()) {
    const { rows } = await db.query(
      `select 1 from campaigns where id = $2 and tenant_id = $1`,
      [par.tenantId, par.campaignId],
    );
    if (!rows[0]) {
      throw new Error(
        `Campanha ${par.campaignId} não pertence ao tenant ${par.tenantId}: ` +
          `uma empresa não pode cruzar tenants.`,
      );
    }
  }

  const colunasPorLinha = 11;
  const valores: unknown[] = [];
  const marcadores = empresas.map((e, i) => {
    const base = i * colunasPorLinha;
    valores.push(
      e.tenantId,
      e.campaignId,
      e.cnpj,
      e.legalName,
      e.tradeName,
      e.website,
      e.city,
      e.uf,
      e.employeeCount,
      e.summary,
      e.source,
    );
    const p = Array.from(
      { length: colunasPorLinha },
      (_, j) => `$${base + j + 1}`,
    );
    return `(${p.join(", ")})`;
  });

  const { rows } = await db.query<{ id: string }>(
    `insert into companies
       (tenant_id, campaign_id, cnpj, legal_name, trade_name, website,
        city, uf, employee_count, summary, source)
     values ${marcadores.join(", ")}
     on conflict (tenant_id, cnpj) where cnpj is not null do nothing
     returning id`,
    valores,
  );

  return {
    inseridas: rows.length,
    ignoradas: empresas.length - rows.length,
  };
}

export async function listarPendentesDeEnriquecimento(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select ${COLUNAS} from companies
     where tenant_id = $1 and campaign_id = $2 and enrichment_status = 'pending'
     order by created_at
     limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}

export async function marcarEnriquecimento(
  db: Db,
  tenantId: string,
  companyId: string,
  status: "enriched" | "failed",
): Promise<void> {
  await db.query(
    `update companies set enrichment_status = $3
     where tenant_id = $1 and id = $2`,
    [tenantId, companyId, status],
  );
}

export interface ContagemDeEmpresas {
  pending: number;
  enriched: number;
  failed: number;
}

/**
 * Conta as empresas da campanha por status de enriquecimento.
 *
 * O `::int` é obrigatório: `count(*)` volta `number` no PGlite e **string** no
 * node-pg, então sem o cast o painel somaria strings e mostraria "01" onde
 * deveria mostrar 1.
 *
 * Os três status são preenchidos com zero antes do `group by` entrar. O SQL
 * simplesmente não devolve linha para status sem nenhuma empresa, e uma coluna
 * ausente viraria `undefined` na tela — que o operador lê como "não sei", e
 * não como "nenhuma".
 */
export async function contarEmpresasPorStatus(
  db: Db,
  tenantId: string,
  campaignId: string,
): Promise<ContagemDeEmpresas> {
  const { rows } = await db.query<{ status: string; total: number }>(
    `select enrichment_status as status, count(*)::int as total
     from companies
     where tenant_id = $1 and campaign_id = $2
     group by enrichment_status`,
    [tenantId, campaignId],
  );

  const contagem: ContagemDeEmpresas = { pending: 0, enriched: 0, failed: 0 };
  for (const linha of rows) {
    if (linha.status in contagem) {
      contagem[linha.status as keyof ContagemDeEmpresas] = linha.total;
    }
  }
  return contagem;
}

export interface EmpresaDoPainel extends Company {
  /**
   * O payload da última tentativa de enriquecimento desta empresa, ou `null`
   * se ela nunca foi tentada. É de onde a tela tira o motivo de uma empresa
   * ter ficado `failed`.
   */
  ultima_tentativa: unknown | null;
}

/**
 * Lista as empresas da campanha com o resultado da última tentativa.
 *
 * O join lateral existe porque a alternativa é a tela buscar os eventos de
 * cada empresa numa chamada separada — cem empresas, cem consultas. Aqui o
 * banco resolve de uma vez.
 *
 * `payload->>'companyId'` compara texto com texto: `companies.id` é `uuid` e
 * o valor dentro do `jsonb` é string, e o Postgres recusa comparar os dois
 * sem o cast explícito.
 */
export async function listarEmpresasDaCampanha(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<EmpresaDoPainel[]> {
  const { rows } = await db.query<EmpresaDoPainel>(
    `select c.id, c.tenant_id, c.campaign_id, c.cnpj, c.legal_name,
            c.trade_name, c.website, c.city, c.uf, c.employee_count,
            c.summary, c.source, c.enrichment_status, c.created_at,
            e.payload as ultima_tentativa
       from companies c
       left join lateral (
         select payload
           from events
          where tenant_id = c.tenant_id
            and kind = 'tentativa_de_enriquecimento'
            and payload->>'companyId' = c.id::text
          order by created_at desc
          limit 1
       ) e on true
      where c.tenant_id = $1 and c.campaign_id = $2
      order by c.created_at desc
      limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}
