export type FetchLike = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
    url: string,
  ) {
    super(`HTTP ${status} em ${url}: ${corpo.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export interface OpcoesHttp {
  fetch?: FetchLike;
  timeoutMs?: number;
  tentativas?: number;
  /** Status extras que valem uma nova tentativa, além de 429 e 5xx. */
  statusParaRepetir?: readonly number[];
}

const REPETIVEIS_PADRAO = [429];

function valeRepetir(status: number, extras: readonly number[]): boolean {
  return status >= 500 || REPETIVEIS_PADRAO.includes(status) || extras.includes(status);
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET de JSON com timeout, retry e erro tipado.
 *
 * Repete apenas o que melhora com insistência: 429, 5xx e os status extras que
 * o chamador declarar (a Hunter usa 202 e 222 para "ainda processando"). Um
 * 4xx é resposta definitiva do servidor e falha na primeira tentativa.
 */
export async function fetchJson<T>(
  url: string,
  opcoes: OpcoesHttp = {},
): Promise<T> {
  const {
    fetch: fetchFn = globalThis.fetch,
    timeoutMs = 15_000,
    tentativas = 2,
    statusParaRepetir = [],
  } = opcoes;

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const ultimaTentativa = tentativa === tentativas;
    const controlador = new AbortController();
    const relogio = setTimeout(() => controlador.abort(), timeoutMs);

    let resposta: Response;
    try {
      resposta = await fetchFn(url, { signal: controlador.signal });
    } catch (erro) {
      // Um timeout falha de imediato: se o servidor não respondeu em 15 s,
      // insistir no mesmo instante raramente ajuda e atrasa o lote inteiro.
      if (erro instanceof DOMException && erro.name === "AbortError") {
        throw new Error(`Tempo esgotado (${timeoutMs} ms) em ${url}`);
      }
      throw erro;
    } finally {
      clearTimeout(relogio);
    }

    if (resposta.ok && !statusParaRepetir.includes(resposta.status)) {
      const texto = await resposta.text();
      try {
        return JSON.parse(texto) as T;
      } catch {
        throw new Error(
          `Resposta de ${url} não é JSON válido: ${texto.slice(0, 200)}`,
        );
      }
    }

    const erro = new HttpError(resposta.status, await resposta.text(), url);
    if (!valeRepetir(resposta.status, statusParaRepetir) || ultimaTentativa) {
      throw erro;
    }
    await espera(300 * tentativa);
  }

  // Inalcançável: o laço sempre retorna ou lança. Presente para o compilador.
  throw new Error(`Falha ao chamar ${url}`);
}
