import { describe, it, expect, vi } from "vitest";
import {
  pesquisarEmpresas,
  temFiltroUtil,
} from "../../src/discovery/casa-dos-dados.js";
import type { NicheFilters } from "../../src/ai/niche-parser.js";

function filtros(overrides: Partial<NicheFilters> = {}): NicheFilters {
  return {
    cnaes: [],
    ufs: [],
    cities: [],
    min_employees: null,
    max_employees: null,
    target_roles: [],
    keywords: [],
    setores: [],
    tecnologias: [],
    paises: [],
    ...overrides,
  };
}

function respostaFake(corpo: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(corpo), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("temFiltroUtil", () => {
  it("é falso sem cnae, uf ou cidade", () => {
    expect(temFiltroUtil(filtros())).toBe(false);
  });

  it("é verdadeiro com cnae", () => {
    expect(temFiltroUtil(filtros({ cnaes: ["6201501"] }))).toBe(true);
  });

  it("é verdadeiro com uf", () => {
    expect(temFiltroUtil(filtros({ ufs: ["SC"] }))).toBe(true);
  });

  it("é verdadeiro com cidade, mesmo sem cnae ou uf", () => {
    expect(temFiltroUtil(filtros({ cities: ["Joinville"] }))).toBe(true);
  });

  it("ignora keywords e faixa de funcionários — não é filtro útil aqui", () => {
    expect(
      temFiltroUtil(filtros({ keywords: ["climatização"], min_employees: 10 })),
    ).toBe(false);
  });
});

describe("pesquisarEmpresas", () => {
  it("manda a api-key no header e os filtros no corpo", async () => {
    const fetchFn = respostaFake({ total: 0, cnpjs: [] });
    await pesquisarEmpresas(
      filtros({ cnaes: ["6201501"], ufs: ["SC"], cities: ["Joinville"] }),
      { apiKey: "chave-teste", pagina: 2, limite: 50 },
      { fetch: fetchFn },
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opcoes] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.casadosdados.com.br/v5/cnpj/pesquisa");
    expect(opcoes.method).toBe("POST");
    expect(opcoes.headers["api-key"]).toBe("chave-teste");

    const corpo = JSON.parse(opcoes.body as string);
    expect(corpo).toEqual({
      situacao_cadastral: ["ATIVA"],
      limite: 50,
      pagina: 2,
      codigo_atividade_principal: ["6201501"],
      uf: ["sc"],
      municipio: ["Joinville"],
    });
  });

  it("omite do corpo os filtros vazios, em vez de mandar array vazio", async () => {
    const fetchFn = respostaFake({ total: 0, cnpjs: [] });
    await pesquisarEmpresas(filtros(), { apiKey: "chave" }, { fetch: fetchFn });

    const corpo = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(corpo).toEqual({ situacao_cadastral: ["ATIVA"], limite: 100, pagina: 1 });
  });

  it("converte a resposta para o formato interno", async () => {
    const fetchFn = respostaFake({
      total: 1,
      cnpjs: [
        {
          cnpj: "12345678000199",
          razao_social: "ALFA LTDA",
          nome_fantasia: "ALFA",
          endereco: { uf: "SC", municipio: "JOINVILLE" },
        },
      ],
    });

    const resultado = await pesquisarEmpresas(
      filtros({ ufs: ["SC"] }),
      { apiKey: "chave" },
      { fetch: fetchFn },
    );

    expect(resultado).toEqual({
      total: 1,
      empresas: [
        {
          cnpj: "12345678000199",
          razaoSocial: "ALFA LTDA",
          nomeFantasia: "ALFA",
          uf: "SC",
          municipio: "JOINVILLE",
        },
      ],
    });
  });

  it("lida com endereco ausente sem lançar", async () => {
    const fetchFn = respostaFake({
      total: 1,
      cnpjs: [{ cnpj: "12345678000199", razao_social: "ALFA LTDA", nome_fantasia: null }],
    });

    const resultado = await pesquisarEmpresas(
      filtros({ ufs: ["SC"] }),
      { apiKey: "chave" },
      { fetch: fetchFn },
    );

    expect(resultado.empresas[0]).toEqual({
      cnpj: "12345678000199",
      razaoSocial: "ALFA LTDA",
      nomeFantasia: null,
      uf: null,
      municipio: null,
    });
  });

  it("propaga erro HTTP em vez de devolver lista vazia", async () => {
    const fetchFn = respostaFake({ erro: "chave inválida" }, 401);
    await expect(
      pesquisarEmpresas(filtros({ ufs: ["SC"] }), { apiKey: "errada" }, { fetch: fetchFn }),
    ).rejects.toThrow(/401/);
  });
});
