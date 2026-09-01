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

  it("aceita setor ou tecnologia, e só", () => {
    expect(temFiltroDeEmpresaUtil(filtros({ setores: ["Food & Beverage"] }))).toBe(true);
    expect(temFiltroDeEmpresaUtil(filtros({ tecnologias: ["SAP"] }))).toBe(true);
    // Porte NÃO conta: `sizes` saiu do payload até dar para ler os valores
    // que a Lusha aceita, então aceitá-lo aqui deixaria passar uma busca que
    // na prática não filtra nada.
    expect(temFiltroDeEmpresaUtil(filtros({ min_employees: 300 }))).toBe(false);
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
    // O setor saiu do payload: a Lusha recusou `industries` e
    // `industriesLabels`, e continuar chutando custa um deploy por palpite.
    expect(incluir.industriesLabels).toBeUndefined();
    expect(incluir.industries).toBeUndefined();
    expect(incluir.technologies).toEqual(["SAP"]);
    // `sizes` fora do payload por enquanto: é lista fechada na Lusha e o
    // formato não foi confirmado. Mandar errado custaria um ciclo de deploy.
    expect(incluir.sizes).toBeUndefined();
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

describe("filtro recusado", () => {
  it("no 400, pergunta à Lusha quais filtros ela aceita", async () => {
    // A Lusha aponta um campo errado por vez ("property industries should not
    // exist"). Sem isto, cada nome errado custaria um ciclo de deploy para
    // descobrir o seguinte. `/prospecting/filters` é endpoint de descoberta e
    // devolve a lista inteira de uma vez.
    let chamada = 0;
    const fetchFalso = vi.fn(async () => {
      chamada += 1;
      if (chamada === 1) {
        return new Response(
          JSON.stringify({ message: "property industries should not exist" }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ name: "industriesLabels" }, { name: "sizes" }] }),
        { status: 200 },
      );
    });

    await expect(
      pesquisarEmpresasNaLusha(
        filtros({ setores: ["X"] }),
        { apiKey: "k" },
        { fetch: fetchFalso as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/industriesLabels, sizes/);
  });

  it("se a própria consulta de filtros falhar, o 400 original prevalece", async () => {
    // Trocar o erro que interessa por "falhou ao listar filtros" afastaria o
    // diagnóstico da causa.
    const fetchFalso = vi.fn(async () =>
      new Response(JSON.stringify({ message: "campo x invalido" }), { status: 400 }),
    );

    await expect(
      pesquisarEmpresasNaLusha(
        filtros({ setores: ["X"] }),
        { apiKey: "k" },
        { fetch: fetchFalso as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/campo x invalido/);
  });
});

describe("leitura da lista de filtros", () => {
  it("aceita array no topo, sem envelope", async () => {
    // Foi o formato que a primeira versão não previu: ela só olhava dentro de
    // `data`/`results`, a resposta veio como array puro, e o ciclo de deploy
    // inteiro terminou sem ensinar nada.
    let chamada = 0;
    const fetchFalso = vi.fn(async () => {
      chamada += 1;
      if (chamada === 1) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify(["sizes", "revenues", "technologies"]), {
        status: 200,
      });
    });

    await expect(
      pesquisarEmpresasNaLusha(
        filtros({ tecnologias: ["SAP"] }),
        { apiKey: "k" },
        { fetch: fetchFalso as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/sizes, revenues, technologies/);
  });

  it("quando não sabe ler, devolve a resposta crua", async () => {
    // Uma resposta que não encaixa no formato esperado é informação: é ela
    // que revela o formato real. Devolver vazio joga isso fora.
    let chamada = 0;
    const fetchFalso = vi.fn(async () => {
      chamada += 1;
      if (chamada === 1) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ algoInesperado: { a: 1 } }), { status: 200 });
    });

    await expect(
      pesquisarEmpresasNaLusha(
        filtros({ tecnologias: ["SAP"] }),
        { apiKey: "k" },
        { fetch: fetchFalso as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/formato inesperado.*algoInesperado/s);
  });
});

describe("página mínima da API", () => {
  it("nunca pede size menor que 10, mesmo pedindo 1 empresa", async () => {
    // A Lusha recusa com "pagination.size must not be less than 10". Pedir uma
    // empresa não pode virar `size: 1`.
    const { fetchFalso, chamadas } = servidor({ data: [] });

    await pesquisarEmpresasNaLusha(
      filtros({ tecnologias: ["SAP"] }),
      { apiKey: "k", limite: 1 },
      { fetch: fetchFalso },
    );

    expect(chamadas[0]?.corpo.pagination.size).toBe(10);
  });

  it("corta o resultado no teto pedido", async () => {
    const dez = Array.from({ length: 10 }, (_, i) => ({
      id: "v1.c" + i,
      name: "Empresa " + i,
      domain: "e" + i + ".com.br",
    }));
    const { fetchFalso } = servidor({ data: dez });

    const r = await pesquisarEmpresasNaLusha(
      filtros({ tecnologias: ["SAP"] }),
      { apiKey: "k", limite: 1 },
      { fetch: fetchFalso },
    );

    expect(r.empresas).toHaveLength(1);
  });
});
