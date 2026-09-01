import { fetchJson, type FetchLike } from "../http/fetch-json.js";
import type { CandidatoDecisor, StatusVerificacao } from "./types.js";

/**
 * Adaptador da Lusha, no lugar da Hunter para achar o decisor.
 *
 * A Casa dos Dados continua descobrindo as empresas: ela vem da Receita e
 * traz CNPJ, CNAE e situação cadastral, que a Lusha não tem e que o funil usa
 * para recusar empresa inativa antes de gastar crédito.
 *
 * ATENÇÃO — contrato não verificado ao vivo. A documentação da Lusha é uma
 * SPA e não entrega os schemas de requisição e resposta a quem não executa
 * JavaScript, então o que está aqui foi escrito a partir do que a
 * documentação descreve em texto: os endpoints, o header `api_key`, os
 * filtros e o fluxo em duas etapas. A leitura da resposta é deliberadamente
 * defensiva — aceita mais de um nome plausível por campo — e, quando não
 * reconhece nada, lança com um resumo da forma recebida em vez de devolver
 * lista vazia. Um erro assim vira `resultado: "erro"` em `tentativas` e fica
 * gravado em `events`, que é onde se lê o que a API realmente respondeu.
 */
const BASE = "https://api.lusha.com";

/** Quantos contatos pedir por empresa. Além disso é ruído para revisar. */
const POR_EMPRESA = 10;

interface Chamada {
  apiKey: string;
  fetch?: FetchLike;
}

async function postar<T>(
  caminho: string,
  corpo: unknown,
  { apiKey, fetch: fetchLike }: Chamada,
): Promise<T> {
  return fetchJson<T>(`${BASE}${caminho}`, {
    fetch: fetchLike,
    metodo: "POST",
    headers: { api_key: apiKey, "content-type": "application/json" },
    corpo: JSON.stringify(corpo),
    tentativas: 3,
  });
}

/**
 * Lê um campo aceitando mais de um nome.
 *
 * Não é preguiça: sem o schema confirmado, fixar um nome só faria o
 * adaptador devolver "nada encontrado" — indistinguível de uma empresa sem
 * decisor — no dia em que o campo se chamasse `email_address` em vez de
 * `email`. Errar o nome do campo tem que parecer erro, não resultado vazio.
 */
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

function objetos(valor: unknown): Record<string, unknown>[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter(
    (i): i is Record<string, unknown> => typeof i === "object" && i !== null,
  );
}

/** A lista de resultados, sob qualquer um dos nomes que a doc menciona. */
function listaDeResultados(resposta: unknown): Record<string, unknown>[] {
  if (typeof resposta !== "object" || resposta === null) return [];
  const r = resposta as Record<string, unknown>;
  for (const nome of ["results", "data", "contacts"]) {
    const lista = objetos(r[nome]);
    if (lista.length > 0) return lista;
  }
  return [];
}

function formaRecebida(resposta: unknown): string {
  if (typeof resposta !== "object" || resposta === null) return typeof resposta;
  return Object.keys(resposta as Record<string, unknown>).join(", ") || "{}";
}

/**
 * Do que a Lusha diz sobre o e-mail para o nosso vocabulário.
 *
 * Sem sinal reconhecível, `accept_all` — que na cadeia significa
 * "indeterminado, não reprovado", e é exatamente o que sabemos: a Lusha
 * entregou o endereço, não afirmou que ele é válido. Marcar `valid` seria
 * afirmar por ela; marcar `invalid` descartaria contato bom. O disjuntor de
 * bounce existe justamente para o que passar daqui e não entregar.
 */
function traduzirStatus(bruto: unknown): StatusVerificacao {
  switch (typeof bruto === "string" ? bruto.toLowerCase() : bruto) {
    case "valid":
    case "verified":
    case true:
      return "valid";
    case "invalid":
    case "bounced":
    case false:
      return "invalid";
    default:
      return "accept_all";
  }
}

/** Lê um campo de qualquer resposta, sem afirmar a forma dela antes da hora. */
function campoDe(resposta: unknown, nome: string): string | null {
  if (typeof resposta !== "object" || resposta === null) return null;
  return texto(resposta as Record<string, unknown>, nome);
}

/**
 * Busca contatos e revela os e-mails.
 *
 * Duas etapas porque a Lusha cobra na segunda: a busca devolve identificadores
 * sem e-mail, e só o enriquecimento revela o endereço consumindo crédito.
 * Fazer as duas aqui dentro mantém a cadeia sem saber disso — para ela, isto
 * continua sendo "ache o decisor".
 */
async function buscarEEnriquecer(
  filtros: Record<string, unknown>,
  chamada: Chamada,
): Promise<Record<string, unknown>[]> {
  const busca = await postar<unknown>(
    "/prospecting/contact/search",
    { pages: { page: 0, size: POR_EMPRESA }, filters: filtros },
    chamada,
  );

  const encontrados = listaDeResultados(busca);
  if (encontrados.length === 0) return [];

  const ids = encontrados
    .map((c) => texto(c, "id", "contactId"))
    .filter((id): id is string => id !== null);

  if (ids.length === 0) {
    throw new Error(
      `Lusha devolveu ${encontrados.length} contato(s) sem identificador reconhecível. ` +
        `Campos vistos: ${formaRecebida(encontrados[0])}`,
    );
  }

  const requestId = campoDe(busca, "requestId");
  const enriquecidos = await postar<unknown>(
    "/prospecting/contact/enrich",
    requestId ? { requestId, contactIds: ids } : { contactIds: ids },
    chamada,
  );

  const lista = listaDeResultados(enriquecidos);
  if (lista.length === 0) {
    throw new Error(
      `Lusha aceitou o enriquecimento mas não devolveu contato reconhecível. ` +
        `Forma recebida: ${formaRecebida(enriquecidos)}`,
    );
  }
  return lista;
}

function paraCandidato(
  bruto: Record<string, unknown>,
  fonte: "lusha_finder" | "lusha_domain",
): CandidatoDecisor | null {
  const email =
    texto(bruto, "email", "emailAddress", "email_address") ??
    texto(objetos(bruto.emails)[0] ?? {}, "email", "address", "value");
  if (!email) return null;

  const inteiro = texto(bruto, "name", "fullName", "full_name");
  const partido = [
    texto(bruto, "firstName", "first_name"),
    texto(bruto, "lastName", "last_name"),
  ]
    .filter((p): p is string => p !== null)
    .join(" ");

  return {
    nome: inteiro ?? (partido || null),
    cargo: texto(bruto, "jobTitle", "job_title", "title", "position"),
    email,
    /**
     * 75 sintético quando a Lusha não dá score próprio: acima do 70 do e-mail
     * declarado à Receita (que pode estar velho) e abaixo do que só uma
     * verificação de verdade justificaria.
     */
    confianca: numero(bruto, "confidence", "score", "emailConfidence") ?? 75,
    verificacao: traduzirStatus(
      bruto.emailStatus ?? bruto.email_status ?? bruto.isValid ?? bruto.status,
    ),
    fonte,
  };
}

/**
 * Acha uma pessoa específica na empresa. Equivale ao email-finder da Hunter.
 *
 * A Lusha não tem busca por nome própria: o nome entra como filtro da busca de
 * contatos, restrita ao domínio da empresa. Se vier mais de um, fica o de
 * maior confiança — o desempate por nome exato não é possível sem saber como
 * ela normaliza acentos, e chutar aqui traria a pessoa errada.
 */
export async function acharEmailPorNome(
  input: {
    dominio?: string;
    empresa?: string;
    primeiroNome: string;
    sobrenome: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor | null> {
  const empresas: Record<string, unknown> = {};
  if (input.dominio) empresas.domains = [input.dominio];
  else if (input.empresa) empresas.names = [input.empresa];
  else return null;

  const contatos = await buscarEEnriquecer(
    {
      companies: { include: empresas },
      contacts: {
        include: { names: [`${input.primeiroNome} ${input.sobrenome}`] },
      },
    },
    { apiKey: input.apiKey, fetch: deps.fetch },
  );

  const candidatos = contatos
    .map((c) => paraCandidato(c, "lusha_finder"))
    .filter((c): c is CandidatoDecisor => c !== null);

  if (candidatos.length === 0) return null;
  return [...candidatos].sort((a, b) => b.confianca - a.confianca)[0]!;
}

/**
 * Acha decisores pelo cargo dentro da empresa. Equivale ao domain-search.
 *
 * O `departamento` e a `senioridade` da cadeia viram os filtros de mesmo nome
 * da Lusha. O departamento vem em português (é o cargo-alvo da campanha) e
 * entra também como `jobTitles`, porque é onde um texto livre tem chance de
 * casar — o campo `departments` da Lusha é uma lista fechada em inglês.
 */
export async function buscarNoDominio(
  input: {
    dominio?: string;
    empresa?: string;
    departamento?: string;
    senioridade?: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor[]> {
  const empresas: Record<string, unknown> = {};
  if (input.dominio) empresas.domains = [input.dominio];
  else if (input.empresa) empresas.names = [input.empresa];
  else return [];

  const contatos: Record<string, unknown> = {};
  if (input.departamento) contatos.jobTitles = [input.departamento];
  if (input.senioridade) contatos.seniority = [input.senioridade];

  const encontrados = await buscarEEnriquecer(
    {
      companies: { include: empresas },
      ...(Object.keys(contatos).length ? { contacts: { include: contatos } } : {}),
    },
    { apiKey: input.apiKey, fetch: deps.fetch },
  );

  return encontrados
    .map((c) => paraCandidato(c, "lusha_domain"))
    .filter((c): c is CandidatoDecisor => c !== null);
}

/**
 * A Lusha não verifica e-mail avulso.
 *
 * Devolve `unknown`, que a cadeia não aprova — de propósito. Este caminho só é
 * usado para o e-mail declarado à Receita, que chega sem verificação nenhuma;
 * aprová-lo sem conferir mandaria e-mail para endereço possivelmente morto e
 * alimentaria o disjuntor de bounce. Os candidatos vindos da própria Lusha
 * nunca passam por aqui: já chegam com status próprio.
 */
export async function verificarEmail(): Promise<{
  status: StatusVerificacao;
  score: number;
}> {
  return { status: "unknown", score: 0 };
}
