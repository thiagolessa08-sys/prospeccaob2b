import { fetchJson, HttpError, type FetchLike } from "../http/fetch-json.js";
import type { NicheFilters } from "../ai/niche-parser.js";

/**
 * Descoberta de empresas pela Lusha, no lugar da Casa dos Dados.
 *
 * A troca resolve o problema que fazia o funil achar zero decisores: o funil
 * descobria empresa na Receita e depois perguntava à Lusha por ela, usando a
 * razão social como identificador. A Lusha não indexa
 * `INDUSTRIA DE ALIMENTOS XYZ LTDA` — ela conhece `XYZ Alimentos`, pelo
 * domínio. Cem buscas responderam "vazio" corretamente, porque perguntavam
 * por empresas que, do ponto de vista dela, não existem.
 *
 * Descobrindo aqui, a empresa vem com o id do grafo dela e com domínio, e a
 * busca de contato passa a rodar sobre algo que ela reconhece.
 *
 * Custo em cota: esta busca é PAGINADA — traz dezenas de empresas por
 * chamada, enquanto a busca de contato gasta uma chamada por empresa. É o
 * oposto do arranjo anterior, que gastava o caro para acertar zero.
 *
 * O que se perde, e é real: sem CNPJ não há situação cadastral (a trava que
 * recusava empresa baixada antes de gastar crédito), nem quadro societário,
 * nem o e-mail declarado à Receita.
 */
const BASE = "https://api.lusha.com/v3";

/** Cota diária baixa (100 no plano base): páginas grandes gastam menos. */
const POR_PAGINA = 50;

const COTA_ESTOURADA = 429;
const SEM_CREDITO = 402;

export interface EmpresaDaLusha {
  /** O id no grafo da Lusha. Vai para `companies.external_id`. */
  externalId: string;
  nome: string;
  dominio: string | null;
  cidade: string | null;
  uf: string | null;
  funcionarios: number | null;
  setor: string | null;
}

export interface ResultadoDaBuscaDeEmpresas {
  empresas: readonly EmpresaDaLusha[];
  /** Quantas a Lusha diz existir no total, quando informa. */
  total: number | null;
}

/**
 * Há filtro suficiente para não pedir "o mundo inteiro"?
 *
 * Mesma guarda da Casa dos Dados, e pelo mesmo motivo: uma busca sem
 * critério devolveria qualquer empresa e consumiria a cota do dia para trazer
 * lixo. País sozinho não conta — "Brazil" é o padrão e não restringe nada.
 */
export function temFiltroDeEmpresaUtil(filtros: NicheFilters): boolean {
  return (
    filtros.setores.length > 0 ||
    filtros.tecnologias.length > 0 ||
    filtros.min_employees !== null ||
    filtros.max_employees !== null
  );
}

/**
 * UF para o nome do estado, que é o que uma base global entende.
 *
 * A Lusha filtra localização por nome, não por sigla: "SP" não significa nada
 * para ela. Sem acento de propósito — bases internacionais guardam os nomes
 * assim, e um "São Paulo" acentuado tem chance de não casar.
 */
const ESTADOS: Record<string, string> = {
  AC: "Acre", AL: "Alagoas", AP: "Amapa", AM: "Amazonas", BA: "Bahia",
  CE: "Ceara", DF: "Distrito Federal", ES: "Espirito Santo", GO: "Goias",
  MA: "Maranhao", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Para", PB: "Paraiba", PR: "Parana",
  PE: "Pernambuco", PI: "Piaui", RJ: "Rio de Janeiro",
  RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondonia",
  RR: "Roraima", SC: "Santa Catarina", SP: "Sao Paulo", SE: "Sergipe",
  TO: "Tocantins",
};

export function nomeDoEstado(uf: string): string | null {
  return ESTADOS[uf.trim().toUpperCase()] ?? null;
}

function paraFiltros(filtros: NicheFilters): Record<string, unknown> {
  const incluir: Record<string, unknown> = {};

  const paises = filtros.paises.length > 0 ? filtros.paises : ["Brazil"];
  const estados = filtros.ufs
    .map((uf) => nomeDoEstado(uf))
    .filter((nome): nome is string => nome !== null);

  incluir.locations = estados.length
    ? estados.map((estado) => ({ country: paises[0], state: estado }))
    : paises.map((pais) => ({ country: pais }));

  if (filtros.setores.length > 0) incluir.industries = filtros.setores;
  if (filtros.tecnologias.length > 0) incluir.technologies = filtros.tecnologias;

  if (filtros.min_employees !== null || filtros.max_employees !== null) {
    incluir.sizes = [
      { min: filtros.min_employees ?? undefined, max: filtros.max_employees ?? undefined },
    ];
  }

  return { companies: { include: incluir } };
}

function objetos(valor: unknown): Record<string, unknown>[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter(
    (i): i is Record<string, unknown> => typeof i === "object" && i !== null,
  );
}

function texto(obj: Record<string, unknown>, ...nomes: string[]): string | null {
  for (const nome of nomes) {
    const valor = obj[nome];
    if (typeof valor === "string" && valor.trim().length > 0) return valor.trim();
  }
  return null;
}

function numero(obj: Record<string, unknown>, ...nomes: string[]): number | null {
  for (const nome of nomes) {
    const valor = obj[nome];
    if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  }
  return null;
}

function listaDeResultados(resposta: unknown): Record<string, unknown>[] {
  if (typeof resposta !== "object" || resposta === null) return [];
  const r = resposta as Record<string, unknown>;
  for (const nome of ["data", "companies", "results"]) {
    const lista = objetos(r[nome]);
    if (lista.length > 0) return lista;
  }
  return [];
}

function formaRecebida(resposta: unknown): string {
  if (typeof resposta !== "object" || resposta === null) return typeof resposta;
  return Object.keys(resposta as Record<string, unknown>).join(", ") || "{}";
}

/** O endereço vem aninhado em algumas respostas e plano em outras. */
function localDe(bruto: Record<string, unknown>): { cidade: string | null; uf: string | null } {
  const direto = {
    cidade: texto(bruto, "city"),
    uf: texto(bruto, "state", "stateCode"),
  };
  if (direto.cidade || direto.uf) return direto;

  const sede = bruto.location ?? bruto.headquarters ?? bruto.address;
  if (typeof sede !== "object" || sede === null) return { cidade: null, uf: null };

  const s = sede as Record<string, unknown>;
  return { cidade: texto(s, "city"), uf: texto(s, "state", "stateCode") };
}

function paraEmpresa(bruto: Record<string, unknown>): EmpresaDaLusha | null {
  const externalId = texto(bruto, "id", "companyId", "lushaCompanyId");
  const nome = texto(bruto, "name", "companyName", "legalName");
  // Sem id não dá para pedir os contatos depois; sem nome não há o que gravar.
  if (!externalId || !nome) return null;

  const local = localDe(bruto);
  return {
    externalId,
    nome,
    dominio: texto(bruto, "domain", "website", "companyDomain"),
    cidade: local.cidade,
    uf: local.uf,
    funcionarios: numero(bruto, "employees", "employeesCount", "size"),
    setor: texto(bruto, "industry", "mainIndustry"),
  };
}

/**
 * Uma página de empresas que casam com o nicho.
 *
 * Uma tentativa, sem repetição: o limite da Lusha é diário, e repetir um 429
 * consome mais uma da cota que acabou de estourar sem chance de dar certo.
 */
export async function pesquisarEmpresasNaLusha(
  filtros: NicheFilters,
  opts: { apiKey: string; pagina?: number; limite?: number },
  deps: { fetch?: FetchLike } = {},
): Promise<ResultadoDaBuscaDeEmpresas> {
  const { apiKey, pagina = 0, limite = POR_PAGINA } = opts;

  let resposta: unknown;
  try {
    resposta = await fetchJson<unknown>(`${BASE}/companies/prospecting`, {
      fetch: deps.fetch,
      metodo: "POST",
      headers: { api_key: apiKey, "content-type": "application/json" },
      corpo: JSON.stringify({
        pagination: { page: pagina, size: limite },
        filters: paraFiltros(filtros),
      }),
      timeoutMs: 30_000,
      tentativas: 1,
    });
  } catch (erro) {
    if (erro instanceof HttpError && erro.status === COTA_ESTOURADA) {
      throw new Error(
        "Lusha: cota diária de chamadas esgotada (HTTP 429). A descoberta e o " +
          "enriquecimento dividem a mesma cota.",
      );
    }
    if (erro instanceof HttpError && erro.status === SEM_CREDITO) {
      throw new Error(
        "Lusha recusou por falta de crédito (HTTP 402) na busca de empresas.",
      );
    }
    throw erro;
  }

  const brutas = listaDeResultados(resposta);
  const empresas = brutas
    .map(paraEmpresa)
    .filter((e): e is EmpresaDaLusha => e !== null);

  /**
   * Achou linhas mas nenhuma legível: é campo renomeado, não busca vazia.
   * Lançar em vez de devolver lista vazia — vazio se disfarçaria de "não há
   * empresa com esse perfil" e mandaria afrouxar o filtro à toa.
   */
  if (brutas.length > 0 && empresas.length === 0) {
    throw new Error(
      `Lusha devolveu ${brutas.length} empresa(s) sem id ou nome reconhecível. ` +
        `Campos vistos: ${formaRecebida(brutas[0])}`,
    );
  }

  const total =
    typeof resposta === "object" && resposta !== null
      ? numero(resposta as Record<string, unknown>, "total", "totalResults")
      : null;

  return { empresas, total };
}
