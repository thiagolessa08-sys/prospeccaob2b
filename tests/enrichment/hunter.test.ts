import { describe, it, expect } from "vitest";
import {
  acharEmailPorNome,
  buscarNoDominio,
  verificarEmail,
} from "../../src/enrichment/hunter.js";
import { respostaJson, respostaVazia, fetchFalso } from "../helpers/http-mock.js";

const CHAVE = "chave-de-teste";

describe("acharEmailPorNome", () => {
  it("traduz a resposta do email-finder", async () => {
    const fake = fetchFalso([
      respostaJson({
        data: {
          email: "maria.souza@alfa.com.br",
          score: 94,
          position: "Diretora de Operações",
          verification: { status: "valid", date: "2026-08-30" },
        },
      }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "Maria", sobrenome: "Souza", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato).toEqual({
      nome: "Maria Souza",
      cargo: "Diretora de Operações",
      email: "maria.souza@alfa.com.br",
      confianca: 94,
      verificacao: "valid",
      fonte: "hunter_finder",
    });
  });

  it("monta a URL com os parâmetros certos", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { email: "a@b.com", score: 50, verification: { status: "unknown" } } }),
    ]);
    await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "Maria", sobrenome: "Souza", apiKey: CHAVE },
      { fetch: fake },
    );
    const url = fake.chamadas[0]!;
    expect(url).toContain("https://api.hunter.io/v2/email-finder");
    expect(url).toContain("domain=alfa.com.br");
    expect(url).toContain("first_name=Maria");
    expect(url).toContain("last_name=Souza");
    expect(url).toContain(`api_key=${CHAVE}`);
  });

  it("devolve null quando a Hunter não acha e-mail", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { email: null, score: 0, verification: { status: "unknown" } } }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "Maria", sobrenome: "Souza", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato).toBeNull();
  });

  it("mapeia um status desconhecido para 'unknown' em vez de vazar o termo da Hunter", async () => {
    const fake = fetchFalso([
      respostaJson({
        data: { email: "a@b.com", score: 40, verification: { status: "algo_novo" } },
      }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "b.com", primeiroNome: "A", sobrenome: "B", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato?.verificacao).toBe("unknown");
  });

  it("repete quando a Hunter responde 202 (ainda processando)", async () => {
    const fake = fetchFalso([
      respostaVazia(202),
      respostaJson({ data: { email: "a@b.com", score: 70, verification: { status: "valid" } } }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "b.com", primeiroNome: "A", sobrenome: "B", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato?.email).toBe("a@b.com");
    expect(fake.chamadas.length).toBe(2);
  });
});

describe("buscarNoDominio", () => {
  it("traduz a lista de contatos", async () => {
    const fake = fetchFalso([
      respostaJson({
        data: {
          emails: [
            {
              value: "joao@alfa.com.br",
              confidence: 88,
              first_name: "João",
              last_name: "Lima",
              position: "Gerente de TI",
              department: "it",
              verification: { status: "valid" },
            },
            {
              value: "contato@alfa.com.br",
              confidence: 99,
              first_name: null,
              last_name: null,
              position: null,
              department: null,
              verification: { status: "valid" },
            },
          ],
        },
      }),
    ]);
    const candidatos = await buscarNoDominio(
      { dominio: "alfa.com.br", departamento: "it", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidatos).toHaveLength(2);
    expect(candidatos[0]).toEqual({
      nome: "João Lima",
      cargo: "Gerente de TI",
      email: "joao@alfa.com.br",
      confianca: 88,
      verificacao: "valid",
      fonte: "hunter_domain",
    });
    expect(candidatos[1]!.nome).toBeNull();
  });

  it("devolve lista vazia quando não há contatos", async () => {
    const fake = fetchFalso([respostaJson({ data: { emails: [] } })]);
    const candidatos = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidatos).toEqual([]);
  });

  it("passa os filtros de departamento e senioridade", async () => {
    const fake = fetchFalso([respostaJson({ data: { emails: [] } })]);
    await buscarNoDominio(
      { dominio: "alfa.com.br", departamento: "it", senioridade: "executive", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(fake.chamadas[0]).toContain("department=it");
    expect(fake.chamadas[0]).toContain("seniority=executive");
  });
});

describe("verificarEmail", () => {
  it("devolve status e score", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { status: "valid", score: 97 } }),
    ]);
    const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
    expect(r).toEqual({ status: "valid", score: 97 });
  });

  it("mapeia webmail e disposable para invalid, que não servem para prospecção B2B", async () => {
    for (const bruto of ["webmail", "disposable"]) {
      const fake = fetchFalso([respostaJson({ data: { status: bruto, score: 10 } })]);
      const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
      expect(r.status, bruto).toBe("invalid");
    }
  });

  it("preserva accept_all, que não é nem válido nem inválido", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { status: "accept_all", score: 55 } }),
    ]);
    const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
    expect(r.status).toBe("accept_all");
  });

  it("repete no 222, que é timeout de SMTP", async () => {
    const fake = fetchFalso([
      respostaVazia(222),
      respostaJson({ data: { status: "valid", score: 90 } }),
    ]);
    const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
    expect(r.status).toBe("valid");
    expect(fake.chamadas.length).toBe(2);
  });
});
