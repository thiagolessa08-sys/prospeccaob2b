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
