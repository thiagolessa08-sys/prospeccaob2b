import { fetchJson, type FetchLike } from "../http/fetch-json.js";
import type { CandidatoDecisor, StatusVerificacao } from "./types.js";

const BASE = "https://api.hunter.io/v2";

/** 202 = processando, 222 = timeout de SMTP. Ambos pedem nova tentativa. */
const STATUS_PARA_REPETIR = [202, 222];

/**
 * Traduz o vocabulário da Hunter para o nosso.
 *
 * `webmail` e `disposable` viram `invalid`: um Gmail pessoal ou um endereço
 * descartável tecnicamente entrega, mas não é o decisor numa empresa — tratar
 * como válido encheria o funil de contatos inúteis.
 */
function traduzirStatus(bruto: unknown): StatusVerificacao {
  switch (bruto) {
    case "valid":
      return "valid";
    case "accept_all":
      return "accept_all";
    case "invalid":
    case "webmail":
    case "disposable":
      return "invalid";
    default:
      return "unknown";
  }
}

function juntarNome(
  primeiro: string | null | undefined,
  ultimo: string | null | undefined,
): string | null {
  const partes = [primeiro, ultimo].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return partes.length ? partes.join(" ") : null;
}

interface RespostaFinder {
  data: {
    email: string | null;
    score: number;
    position?: string | null;
    verification?: { status?: string };
  };
}

/**
 * Como dizer à Hunter de que empresa estamos falando.
 *
 * Os dois endpoints usados aqui aceitam `domain` **ou** `company` (nome), e
 * `domain` tem precedência quando os dois vêm — verificado na documentação
 * oficial da Hunter em 2026-08-31. Aceitar o nome importa muito no Brasil: a
 * busca avançada da Casa dos Dados não devolve site nenhum, e boa parte das
 * empresas não declara e-mail à Receita, então sem este caminho a maioria dos
 * CNPJs descobertos ficaria sem nenhuma forma de procurar o decisor.
 */
function localizarEmpresa(
  parametros: URLSearchParams,
  input: { dominio?: string; empresa?: string },
): void {
  if (input.dominio) {
    parametros.set("domain", input.dominio);
  } else if (input.empresa) {
    parametros.set("company", input.empresa);
  } else {
    throw new Error(
      "Informe o domínio ou o nome da empresa para consultar a Hunter.",
    );
  }
}

export async function acharEmailPorNome(
  input: {
    idExterno?: string;
    dominio?: string;
    empresa?: string;
    primeiroNome: string;
    sobrenome: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor | null> {
  const parametros = new URLSearchParams({
    first_name: input.primeiroNome,
    last_name: input.sobrenome,
    api_key: input.apiKey,
  });
  localizarEmpresa(parametros, input);

  const resposta = await fetchJson<RespostaFinder>(
    `${BASE}/email-finder?${parametros}`,
    { fetch: deps.fetch, tentativas: 3, statusParaRepetir: STATUS_PARA_REPETIR },
  );

  if (!resposta.data.email) return null;

  return {
    nome: juntarNome(input.primeiroNome, input.sobrenome),
    cargo: resposta.data.position ?? null,
    email: resposta.data.email,
    confianca: resposta.data.score,
    verificacao: traduzirStatus(resposta.data.verification?.status),
    fonte: "hunter_finder",
  };
}

interface RespostaDominio {
  data: {
    emails: Array<{
      value: string;
      confidence: number;
      first_name: string | null;
      last_name: string | null;
      position: string | null;
      department: string | null;
      verification?: { status?: string };
    }>;
  };
}

export async function buscarNoDominio(
  input: {
    idExterno?: string;
    dominio?: string;
    empresa?: string;
    departamento?: string;
    /** Ignorado aqui: a Hunter filtra por departamento, não por título. */
    cargos?: readonly string[];
    senioridade?: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor[]> {
  const parametros = new URLSearchParams({
    limit: "10",
    api_key: input.apiKey,
  });
  localizarEmpresa(parametros, input);
  if (input.departamento) parametros.set("department", input.departamento);
  if (input.senioridade) parametros.set("seniority", input.senioridade);

  const resposta = await fetchJson<RespostaDominio>(
    `${BASE}/domain-search?${parametros}`,
    { fetch: deps.fetch, tentativas: 3, statusParaRepetir: STATUS_PARA_REPETIR },
  );

  return resposta.data.emails.map((e) => ({
    nome: juntarNome(e.first_name, e.last_name),
    cargo: e.position,
    email: e.value,
    confianca: e.confidence,
    verificacao: traduzirStatus(e.verification?.status),
    fonte: "hunter_domain" as const,
  }));
}

interface RespostaVerificador {
  data: { status: string; score: number };
}

export async function verificarEmail(
  input: { email: string; apiKey: string },
  deps: { fetch?: FetchLike } = {},
): Promise<{ status: StatusVerificacao; score: number }> {
  const parametros = new URLSearchParams({
    email: input.email,
    api_key: input.apiKey,
  });

  const resposta = await fetchJson<RespostaVerificador>(
    `${BASE}/email-verifier?${parametros}`,
    { fetch: deps.fetch, tentativas: 3, statusParaRepetir: STATUS_PARA_REPETIR },
  );

  return {
    status: traduzirStatus(resposta.data.status),
    score: resposta.data.score,
  };
}
