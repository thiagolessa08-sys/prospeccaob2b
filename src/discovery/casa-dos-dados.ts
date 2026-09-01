import { fetchJson, type FetchLike } from "../http/fetch-json.js";
import type { NicheFilters } from "../ai/niche-parser.js";

const BASE = "https://api.casadosdados.com.br/v5/cnpj/pesquisa";

/**
 * Forma do payload documentada em docs.casadosdados.com.br/pesquisa-avançada-
 * de-empresas, verificada em 2026-08-31. Só os campos que este módulo usa —
 * a API aceita muitos outros (capital social, MEI/Simples, DDD etc.) que não
 * têm equivalente em `NicheFilters` hoje.
 */
interface CorpoDaPesquisa {
  codigo_atividade_principal?: readonly string[];
  uf?: readonly string[];
  municipio?: readonly string[];
  situacao_cadastral: readonly string[];
  limite: number;
  pagina: number;
}

interface ItemDaResposta {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  endereco?: {
    uf?: string | null;
    municipio?: string | null;
  };
}

interface RespostaDaPesquisa {
  total: number;
  cnpjs: readonly ItemDaResposta[];
}

export interface EmpresaEncontrada {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  uf: string | null;
  municipio: string | null;
}

export interface ResultadoDaPesquisa {
  total: number;
  empresas: readonly EmpresaEncontrada[];
}

/**
 * Filtros que fazem a busca avançada valer a pena. Sem nenhum deles, a
 * pesquisa devolveria toda empresa ativa do Brasil — nem é isso que o nicho
 * descreve, nem o volume seria administrável.
 */
export function temFiltroUtil(filtros: NicheFilters): boolean {
  return (
    filtros.cnaes.length > 0 || filtros.ufs.length > 0 || filtros.cities.length > 0
  );
}

/**
 * `NicheFilters.keywords` fica de fora de propósito: a única busca textual
 * que a API oferece (`busca_textual`) casa contra razão social, nome
 * fantasia ou nome de sócio — não contra a atividade da empresa. Usá-la para
 * as palavras-chave do nicho devolveria empresas cujo *nome* contém o termo,
 * não empresas que *atuam* nele. Preferível não filtrar por isso a filtrar
 * errado. `min_employees`/`max_employees` também ficam de fora: a API não
 * tem um filtro de quantidade de funcionários, só de porte (micro/pequena/
 * outras), que não é a mesma coisa.
 */
function paraPayload(
  filtros: NicheFilters,
  pagina: number,
  limite: number,
): CorpoDaPesquisa {
  const corpo: CorpoDaPesquisa = {
    situacao_cadastral: ["ATIVA"],
    limite,
    pagina,
  };
  if (filtros.cnaes.length > 0) corpo.codigo_atividade_principal = filtros.cnaes;
  if (filtros.ufs.length > 0) corpo.uf = filtros.ufs.map((uf) => uf.toLowerCase());
  if (filtros.cities.length > 0) corpo.municipio = filtros.cities;
  return corpo;
}

/**
 * Busca uma página de empresas ativas que casam com o nicho.
 *
 * `limite` vai de 1 a 1000 na API; mantemos o teto bem abaixo disso (ver
 * `descobrirEmpresas`) para que uma falha no meio do lote perca pouco
 * trabalho.
 */
export async function pesquisarEmpresas(
  filtros: NicheFilters,
  opts: { apiKey: string; pagina?: number; limite?: number },
  deps: { fetch?: FetchLike } = {},
): Promise<ResultadoDaPesquisa> {
  const { apiKey, pagina = 1, limite = 100 } = opts;

  const bruto = await fetchJson<RespostaDaPesquisa>(BASE, {
    fetch: deps.fetch,
    metodo: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json" },
    corpo: JSON.stringify(paraPayload(filtros, pagina, limite)),
    timeoutMs: 20_000,
    tentativas: 2,
  });

  return {
    total: bruto.total,
    empresas: bruto.cnpjs.map((item) => ({
      cnpj: item.cnpj,
      razaoSocial: item.razao_social,
      nomeFantasia: item.nome_fantasia,
      uf: item.endereco?.uf ?? null,
      municipio: item.endereco?.municipio ?? null,
    })),
  };
}
