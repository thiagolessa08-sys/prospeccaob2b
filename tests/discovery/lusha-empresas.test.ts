import { describe, it, expect, vi } from "vitest";
import {
  pesquisarEmpresasNaLusha,
  temFiltroDeEmpresaUtil,
  nomeDoEstado,
} from "../../src/discovery/lusha-empresas.js";
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

function servidor(corpo: unknown, status = 200) {
  const chamadas: Array<{ url: string; corpo: any }> = [];
  const fetchFalso = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({
      url: String(url),
      corpo: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify(corpo), { status });
  });
  return { fetchFalso: fetchFalso as unknown as typeof fetch, chamadas };
}

describe("temFiltroDeEmpresaUtil", () => {
  it("recusa nicho sem nada além de país", () => {
    // Buscar só por "Brazil" devolveria qualquer empresa e gastaria a cota
    // do dia para trazer lixo.
    expect(temFiltroDeEmpresaUtil(filtros({ paises: ["Brazil"] }))).toBe(false);
    expect(temFiltroDeEmpresaUtil(filtros({ ufs: ["SP"] }))).toBe(false);
  });

  it("aceita setor, tecnologia ou porte", () => {
    expect(temFiltroDeEmpresaUtil(filtros({ setores: ["Food & Beverage"] }))).toBe(true);
    expect(temFiltroDeEmpresaUtil(filtros({ tecnologias: ["SAP"] }))).toBe(true);
    expect(temFiltroDeEmpresaUtil(filtros({ min_employees: 300 }))).toBe(true);
  });

  it("recusa os filtros da Receita, que a Lusha não entende", () => {
    // CNAE não significa nada para uma base global. Um nicho só com CNAE
    // buscaria o Brasil inteiro se passasse daqui.
    expect(temFiltroDeEmpresaUtil(filtros({ cnaes: ["1091102"] }))).toBe(false);
  });
});

describe("nomeDoEstado", () => {
  it("traduz a sigla, sem acento", () => {
    // Bases internacionais guardam "Sao Paulo"; o acentuado tem chance de
    // não casar.
    expect(nomeDoEstado("SP")).toBe("Sao Paulo");
    expect(nomeDoEstado("sc")).toBe("Santa Catarina");
    expect(nomeDoEstado("XX")).toBeNull();
  });
});

describe("pesquisarEmpresasNaLusha", () => {
  it("monta o filtro no vocabulário da Lusha", async () => {
    const { fetchFalso, chamadas } = servidor({ data: [] });

    await pesquisarEmpresasNaLusha(
      filtros({
        ufs: ["SP", "SC"],
        setores: ["Food & Beverage"],
        tecnologias: ["SAP"],
        min_employees: 300,
      }),
      { apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(chamadas[0]?.url).toBe("https://api.lusha.com/v3/companies/prospecting");
    const incluir = chamadas[0]?.corpo.filters.companies.include;
    expect(incluir.locations).toEqual([
      { country: "Brazil", state: "Sao Paulo" },
      { country: "Brazil", state: "Santa Catarina" },
    ]);
    expect(incluir.industries).toEqual(["Food & Beverage"]);
    expect(incluir.technologies).toEqual(["SAP"]);
    expect(incluir.sizes).toEqual([{ min: 300 }]);
    // Nada de CNAE: a Lusha não sabe o que é isso.
    expect(JSON.stringify(incluir)).not.toContain("cnae");
  });

  it("lê id, nome e domínio da resposta", async () => {
    const { fetchFalso } = servidor({
      data: [
        {
          id: "v1.company.abc",
          name: "Alfa Alimentos",
          domain: "alfa.com.br",
          employees: 450,
          location: { city: "Joinville", state: "SC" },
        },
      ],
    });

    const r = await pesquisarEmpresasNaLusha(
      filtros({ setores: ["Food & Beverage"] }),
      { apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(r.empresas).toHaveLength(1);
    expect(r.empresas[0]).toMatchObject({
      externalId: "v1.company.abc",
      nome: "Alfa Alimentos",
      dominio: "alfa.com.br",
      cidade: "Joinville",
      uf: "SC",
      funcionarios: 450,
    });
  });

  it("lança quando vêm linhas mas nenhuma legível", async () => {
    // Campo renomeado, não busca vazia. Devolver lista vazia mandaria
    // afrouxar o filtro à toa.
    const { fetchFalso } = servidor({ data: [{ campo_estranho: 1 }] });

    await expect(
      pesquisarEmpresasNaLusha(
        filtros({ setores: ["Food & Beverage"] }),
        { apiKey: "k" },
        { fetch: fetchFalso },
      ),
    ).rejects.toThrow(/sem id ou nome reconhec/i);
  });

  it("traduz o 429 lembrando que a cota é dividida com o enriquecimento", async () => {
    const { fetchFalso } = servidor({ message: "Daily API rate limit exceeded" }, 429);

    await expect(
      pesquisarEmpresasNaLusha(
        filtros({ setores: ["Food & Beverage"] }),
        { apiKey: "k" },
        { fetch: fetchFalso },
      ),
    ).rejects.toThrow(/mesma cota/i);
  });

  it("não repete a chamada", async () => {
    // Repetir limite diário nunca dá certo e consome mais uma da cota.
    const { fetchFalso } = servidor({ message: "limit" }, 429);
    await pesquisarEmpresasNaLusha(
      filtros({ setores: ["X"] }),
      { apiKey: "k" },
      { fetch: fetchFalso },
    ).catch(() => {});
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });
});
