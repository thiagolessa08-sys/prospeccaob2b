import { describe, it, expect } from "vitest";
import { fetchJson, HttpError } from "../../src/http/fetch-json.js";
import {
  respostaJson,
  respostaVazia,
  fetchFalso,
  fetchQueTrava,
} from "../helpers/http-mock.js";

describe("fetchJson", () => {
  it("devolve o JSON decodificado", async () => {
    const fake = fetchFalso([respostaJson({ nome: "Alfa" })]);
    const resultado = await fetchJson<{ nome: string }>(
      "https://exemplo.com/a",
      { fetch: fake },
    );
    expect(resultado).toEqual({ nome: "Alfa" });
    expect(fake.chamadas).toEqual(["https://exemplo.com/a"]);
  });

  it("lança HttpError com status e corpo em resposta 4xx", async () => {
    const fake = fetchFalso([respostaJson({ erro: "sem crédito" }, 402)]);
    const erro = await fetchJson("https://exemplo.com/a", {
      fetch: fake,
    }).catch((e) => e);
    expect(erro).toBeInstanceOf(HttpError);
    expect((erro as HttpError).status).toBe(402);
    expect((erro as HttpError).corpo).toContain("sem crédito");
  });

  it("não repete em erro 4xx, que não melhora com insistência", async () => {
    const fake = fetchFalso([respostaJson({ erro: "não achei" }, 404)]);
    await expect(
      fetchJson("https://exemplo.com/a", { fetch: fake, tentativas: 3 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fake.chamadas.length).toBe(1);
  });

  it("repete em 429 e devolve o sucesso seguinte", async () => {
    const fake = fetchFalso([
      respostaVazia(429),
      respostaJson({ nome: "Beta" }),
    ]);
    const resultado = await fetchJson<{ nome: string }>(
      "https://exemplo.com/a",
      { fetch: fake, tentativas: 3 },
    );
    expect(resultado).toEqual({ nome: "Beta" });
    expect(fake.chamadas.length).toBe(2);
  });

  it("repete em 5xx", async () => {
    const fake = fetchFalso([respostaVazia(503), respostaJson({ ok: true })]);
    await expect(
      fetchJson("https://exemplo.com/a", { fetch: fake, tentativas: 3 }),
    ).resolves.toEqual({ ok: true });
    expect(fake.chamadas.length).toBe(2);
  });

  it("desiste depois de esgotar as tentativas e lança o último erro", async () => {
    const fake = fetchFalso([
      respostaVazia(503),
      respostaVazia(503),
      respostaVazia(503),
    ]);
    const erro = await fetchJson("https://exemplo.com/a", {
      fetch: fake,
      tentativas: 3,
    }).catch((e) => e);
    expect((erro as HttpError).status).toBe(503);
    expect(fake.chamadas.length).toBe(3);
  });

  it("aceita status extras como repetíveis, para o 202 da Hunter", async () => {
    const fake = fetchFalso([respostaVazia(202), respostaJson({ ok: true })]);
    await expect(
      fetchJson("https://exemplo.com/a", {
        fetch: fake,
        tentativas: 2,
        statusParaRepetir: [202],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("aborta quando estoura o tempo", async () => {
    await expect(
      fetchJson("https://exemplo.com/a", {
        fetch: fetchQueTrava(),
        timeoutMs: 20,
        tentativas: 1,
      }),
    ).rejects.toThrow(/tempo/i);
  });

  it("lança erro claro quando o corpo não é JSON", async () => {
    const fake = fetchFalso([new Response("<html>ops</html>", { status: 200 })]);
    await expect(
      fetchJson("https://exemplo.com/a", { fetch: fake }),
    ).rejects.toThrow(/JSON/i);
  });
});

describe("fetchJson — identificação", () => {
  it("manda um user-agent próprio, que a borda da BrasilAPI exige", async () => {
    // O user-agent padrão do Node ("node") leva 403 na BrasilAPI, e toda
    // consulta de CNPJ falharia em produção. Descoberto pelo teste de
    // contrato ao vivo — nenhum mock pegaria, porque o mock repete a
    // suposição.
    let recebido: Record<string, string> | undefined;
    const espiao = (async (_input: unknown, init?: RequestInit) => {
      recebido = init?.headers as Record<string, string>;
      return respostaJson({ ok: true });
    }) as typeof fetch;

    await fetchJson("https://brasilapi.com.br/api/cnpj/v1/00000000000191", {
      fetch: espiao,
    });

    expect(recebido?.["user-agent"]).toBe("prospeccao/0.1");
  });

  it("manda método, headers e corpo próprios, preservando o user-agent padrão", async () => {
    let recebido: RequestInit | undefined;
    const espiao = (async (_input: unknown, init?: RequestInit) => {
      recebido = init;
      return respostaJson({ ok: true });
    }) as typeof fetch;

    await fetchJson("https://exemplo.com/a", {
      fetch: espiao,
      metodo: "POST",
      headers: { authorization: "Bearer chave" },
      corpo: JSON.stringify({ x: 1 }),
    });

    expect(recebido?.method).toBe("POST");
    expect(recebido?.body).toBe(JSON.stringify({ x: 1 }));
    const headers = recebido?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer chave");
    expect(headers["user-agent"]).toBe("prospeccao/0.1");
  });
});

/**
 * A Hunter autentica por query param. Qualquer mensagem de erro que carregue a
 * URL crua acaba gravada em `events` e nos logs — com a chave em texto claro.
 */
describe("fetchJson — segredo na URL nunca vaza para a mensagem de erro", () => {
  const SEGREDO = "chave-super-secreta-123";
  const URL_COM_CHAVE = `https://api.hunter.io/v2/email-finder?domain=alfa.com.br&api_key=${SEGREDO}`;

  it("mascara a chave no HttpError", async () => {
    const fake = fetchFalso([respostaJson({ errors: ["sem crédito"] }, 402)]);
    const erro = await fetchJson(URL_COM_CHAVE, { fetch: fake }).catch((e) => e);

    expect(erro).toBeInstanceOf(HttpError);
    expect((erro as Error).message).not.toContain(SEGREDO);
    expect((erro as Error).message).toContain("api_key=***");
    // O resto da URL continua legível: mascarar não pode cegar o diagnóstico.
    expect((erro as Error).message).toContain("domain=alfa.com.br");
  });

  it("mascara a chave no erro de tempo esgotado", async () => {
    const erro = await fetchJson(URL_COM_CHAVE, {
      fetch: fetchQueTrava(),
      timeoutMs: 20,
      tentativas: 1,
    }).catch((e) => e);

    expect((erro as Error).message).toMatch(/tempo/i);
    expect((erro as Error).message).not.toContain(SEGREDO);
    expect((erro as Error).message).toContain("api_key=***");
  });

  it("mascara a chave no erro de resposta não-JSON", async () => {
    const fake = fetchFalso([new Response("<html>ops</html>", { status: 200 })]);
    const erro = await fetchJson(URL_COM_CHAVE, { fetch: fake }).catch((e) => e);

    expect((erro as Error).message).toMatch(/JSON/i);
    expect((erro as Error).message).not.toContain(SEGREDO);
    expect((erro as Error).message).toContain("api_key=***");
  });

  it("mascara também token, secret e password", async () => {
    const fake = fetchFalso([respostaVazia(400)]);
    const erro = await fetchJson(
      "https://exemplo.com/a?token=tok_1&secret=sec_2&password=pwd_3&apikey=ak_4",
      { fetch: fake },
    ).catch((e) => e);

    const msg = (erro as Error).message;
    for (const valor of ["tok_1", "sec_2", "pwd_3", "ak_4"]) {
      expect(msg).not.toContain(valor);
    }
  });

  it("preserva a URL quando ela não é analisável", async () => {
    const fake = fetchFalso([respostaVazia(400)]);
    const erro = await fetchJson("nem-url-de-verdade", { fetch: fake }).catch(
      (e) => e,
    );
    expect((erro as Error).message).toContain("nem-url-de-verdade");
  });
});
