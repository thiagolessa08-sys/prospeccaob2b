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

/**
 * O mínimo que a API aceita em `pagination.size`.
 *
 * Ela recusa menos que isso com "pagination.size must not be less than 10".
 * Pedir 1 empresa não pode virar `size: 1` — pede-se a página mínima e
 * corta-se o resultado, que aqui não custa nada: a busca cobra por chamada
 * paginada, não por empresa devolvida.
 */
const PAGINA_MINIMA = 10;

const COTA_ESTOURADA = 429;
const SEM_CREDITO = 402;
/** Filtro montado errado. A Lusha diz qual campo, mas um por vez. */
const FILTRO_RECUSADO = 400;

/**
 * Pergunta à Lusha quais filtros de empresa ela aceita.
 *
 * Endpoint de descoberta, sem cobrança de crédito. Só é chamado depois de um
 * 400 — não vale gastar uma ida ao servidor em toda busca para uma informação
 * que só interessa quando algo deu errado.
 *
 * Devolve string vazia se a própria consulta falhar: o erro que interessa é o
 * 400 original, e trocá-lo por "falhou ao listar filtros" só afastaria o
 * diagnóstico da causa.
 */
async function tiposDeFiltroAceitos(
  apiKey: string,
  fetchLike?: FetchLike,
): Promise<string> {
  let resposta: unknown;
  try {
    resposta = await fetchJson<unknown>(
      `${BASE}/companies/prospecting/filters`,
      {
        fetch: fetchLike,
        headers: { api_key: apiKey },
        tentativas: 1,
        timeoutMs: 15_000,
      },
    );
  } catch (erro) {
    return `(não consegui listar os filtros: ${
      erro instanceof Error ? erro.message.slice(0, 150) : String(erro)
    })`;
  }

  const nomes = nomesDeFiltro(resposta);
  if (nomes.length > 0) return nomes.join(", ");

  /**
   * Não soube ler — devolve a resposta CRUA, truncada.
   *
   * A primeira versão devolvia string vazia aqui, e o resultado foi um ciclo
   * de deploy inteiro que não ensinou nada: a mensagem de erro chegou sem a
   * lista e sem dizer por quê. Uma resposta que não encaixa no formato
   * esperado é informação — é ela que revela o formato real.
   */
  return `(formato inesperado) ${JSON.stringify(resposta).slice(0, 400)}`;
}

/**
 * Os nomes dos filtros, aceitando os formatos plausíveis de lista.
 *
 * Cobre array no topo, envelope (`data`/`filters`/`results`/`filterTypes`), e
 * itens que são string simples em vez de objeto. Foi justamente o array no
 * topo que a primeira versão não previu — ela só olhava dentro de envelope.
 */
function nomesDeFiltro(resposta: unknown): string[] {
  const bruta: unknown[] = Array.isArray(resposta)
    ? resposta
    : typeof resposta === "object" && resposta !== null
      ? (["data", "filters", "results", "filterTypes"]
          .map((chave) => (resposta as Record<string, unknown>)[chave])
          .find((v) => Array.isArray(v)) as unknown[] | undefined) ?? []
      : [];

  return bruta
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item !== "object" || item === null) return null;
      return texto(item as Record<string, unknown>, "name", "type", "filterType", "id");
    })
    .filter((n): n is string => n !== null && n.length > 0);
}

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
 * Só setor e tecnologia contam. País e estado não restringem o bastante — o
 * Brasil inteiro ainda é o Brasil inteiro —, e o porte deixou de contar
 * quando `sizes` saiu do payload: aceitá-lo aqui deixaria passar uma busca
 * que, na prática, não filtra nada e consome a cota do dia para trazer lixo.
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

  if (filtros.tecnologias.length > 0) incluir.technologies = filtros.tecnologias;

  /**
   * `sizes` é `{min, max}` mesmo — o formato que eu tinha adivinhado certo e
   * removi por excesso de cautela depois de dois nomes de campo recusados.
   */
  if (filtros.min_employees !== null || filtros.max_employees !== null) {
    const faixa: Record<string, number> = {};
    if (filtros.min_employees !== null) faixa.min = filtros.min_employees;
    if (filtros.max_employees !== null) faixa.max = filtros.max_employees;
    incluir.sizes = [faixa];
  }

  /**
   * O setor continua de fora, e agora sabemos por quê.
   *
   * O campo é `mainIndustriesIds` e ele quer IDS, não rótulos — por isso
   * `industries` e `industriesLabels` foram os dois recusados: o segundo é o
   * nome do TIPO de filtro no endpoint de descoberta, não a propriedade do
   * corpo.
   *
   * Mandar "Food & Beverage" ali não resolveria: seria texto onde a API
   * espera número. Traduzir rótulo em id exige ler
   * `/v3/companies/prospecting/filters/industriesLabels` e casar as duas
   * listas — trabalho que só vale a pena depois que o caminho inteiro estiver
   * provado, e que fica registrado aqui para não se perder.
   *
   * Enquanto isso, tecnologia + porte + localização já formam um ICP
   * bastante restrito: "quem usa SAP ou TOTVS, com 300+ funcionários, no
   * Brasil" não é uma busca larga.
   */

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
  // `results` é o nome documentado da V3. Os outros ficam por segurança.
  for (const nome of ["results", "data", "companies"]) {
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
    funcionarios: quantosFuncionarios(bruto),
    setor: texto(bruto, "industry", "mainIndustry"),
  };
}

/**
 * `employeeCount` é objeto — `{exact, min, max}` —, não número.
 *
 * Eu lia como número e recebia `null` em toda empresa, o que apagaria a
 * coluna de funcionários na tela sem erro nenhum: dado ausente disfarçado de
 * dado inexistente. `exact` quando a Lusha sabe; `min` quando ela só dá a
 * faixa, que é melhor que nada para julgar porte.
 */
function quantosFuncionarios(bruto: Record<string, unknown>): number | null {
  const direto = numero(bruto, "employees", "employeesCount", "size");
  if (direto !== null) return direto;

  const contagem = bruto.employeeCount;
  if (typeof contagem !== "object" || contagem === null) return null;
  return numero(contagem as Record<string, unknown>, "exact", "min");
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
  // A página vai no mínimo aceito pela API; o corte para o teto pedido
  // acontece depois, sobre o que voltou.
  const tamanhoDaPagina = Math.max(PAGINA_MINIMA, limite);

  let resposta: unknown;
  try {
    resposta = await fetchJson<unknown>(`${BASE}/companies/prospecting`, {
      fetch: deps.fetch,
      metodo: "POST",
      headers: { api_key: apiKey, "content-type": "application/json" },
      corpo: JSON.stringify({
        pagination: { page: pagina, size: tamanhoDaPagina },
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
    if (erro instanceof HttpError && erro.status === FILTRO_RECUSADO) {
      /**
       * 400 é sempre filtro montado errado, e a Lusha diz qual — mas só um
       * por vez. Descobrir os nomes válidos custaria um ciclo de deploy por
       * campo errado, então perguntamos a ela na hora.
       *
       * `/prospecting/filters` é endpoint de descoberta: lista os tipos de
       * filtro aceitos e não cobra crédito. Uma chamada aqui transforma
       * "errei um nome" em "aqui está a lista inteira dos certos".
       */
      const validos = await tiposDeFiltroAceitos(apiKey, deps.fetch);
      throw new Error(
        `Lusha recusou o filtro (HTTP 400): ${erro.corpo.slice(0, 300)}` +
          (validos ? ` — filtros aceitos por ela: ${validos}` : ""),
      );
    }
    throw erro;
  }

  const brutas = listaDeResultados(resposta);
  const empresas = brutas
    .map(paraEmpresa)
    .filter((e): e is EmpresaDaLusha => e !== null)
    // Corta no teto pedido: a página teve de ser 10 no mínimo, mas quem pediu
    // uma empresa não pode receber dez. Cortar aqui não custa nada — a busca
    // cobra por chamada paginada, não por empresa devolvida.
    .slice(0, limite);

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
