import { vi } from "vitest";
import type { FetchLike } from "../../src/http/fetch-json.js";

/** Monta uma `Response` de JSON, como a API devolveria. */
export function respostaJson(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `Response` sem corpo, para status como 202 e 429. */
export function respostaVazia(status: number): Response {
  return new Response("", { status });
}

export interface FetchFalso {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  chamadas: string[];
  opcoes: (RequestInit | undefined)[];
}

/**
 * Devolve as respostas na ordem em que foram passadas, uma por chamada, e
 * registra cada URL pedida. Esgotada a lista, lança — um teste que chama mais
 * vezes do que previu está errado e deve falhar alto.
 */
export function fetchFalso(respostas: readonly Response[]): FetchFalso {
  let i = 0;
  const chamadas: string[] = [];
  const opcoes: (RequestInit | undefined)[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    chamadas.push(String(input));
    opcoes.push(init);
    const resposta = respostas[i++];
    if (!resposta) {
      throw new Error(
        `fetchFalso: chamada ${i} sem resposta prevista (só ${respostas.length} foram configuradas)`,
      );
    }
    return resposta;
  }) as unknown as FetchFalso;
  fn.chamadas = chamadas;
  fn.opcoes = opcoes;
  return fn;
}

/** `fetch` que sempre estoura o tempo, para testar o timeout. */
export function fetchQueTrava(): FetchLike {
  return (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    })) as FetchLike;
}
