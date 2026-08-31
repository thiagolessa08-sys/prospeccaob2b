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
     on conflict do nothing
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
