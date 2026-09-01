import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { criarCampanha, salvarFiltros } from "../../src/db/repositories/campaigns.js";
import { descobrirEmpresas } from "../../src/discovery/descobrir-empresas.js";
import type { FetchLike } from "../../src/http/fetch-json.js";

let banco: BancoDeTeste;
let contador = 0;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const base = {
  name: "Descoberta",
  nicheDescription: "indústrias de climatização em SC",
  offerDescription: "BI",
  schedulingLink: "https://cal.com/t/30min",
  senderFirstName: "Thiago",
};

async function campanhaComFiltro(filtros: Record<string, unknown> | null) {
  contador += 1;
  const campanha = await criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    ...base,
    name: `Descoberta ${contador}`,
  });
  if (filtros) await salvarFiltros(banco.db, banco.tenantId, campanha.id, filtros);
  return campanha;
}

const FILTRO_VALIDO = {
  cnaes: ["4322301"],
  ufs: ["SC"],
  cities: [],
  min_employees: null,
  max_employees: null,
  target_roles: [],
  keywords: [],
};

function fetchComPaginas(paginas: Array<Array<{ cnpj: string }>>): FetchLike {
  let chamada = 0;
  return vi.fn().mockImplementation(async () => {
    const pagina = paginas[chamada] ?? [];
    chamada += 1;
    const cnpjs = pagina.map((e) => ({
      cnpj: e.cnpj,
      razao_social: `Empresa ${e.cnpj}`,
      nome_fantasia: null,
      endereco: { uf: "SC", municipio: "Joinville" },
    }));
    return new Response(JSON.stringify({ total: cnpjs.length, cnpjs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchLike;
}

describe("descobrirEmpresas — casos de entrada", () => {
  it("recusa campanha inexistente", async () => {
    const resultado = await descobrirEmpresas({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: "99999999-9999-9999-9999-999999999999",
      apiKey: "chave",
    });
    expect(resultado).toEqual({
      encontradas: 0,
      salvas: 0,
      ignoradas: 0,
      paginas: 0,
      motivo: "Campanha não encontrada.",
    });
  });

  it("recusa campanha sem filtros salvos", async () => {
    const campanha = await campanhaComFiltro(null);
    const resultado = await descobrirEmpresas({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      apiKey: "chave",
    });
    expect(resultado.motivo).toMatch(/sem filtros/);
    expect(resultado.salvas).toBe(0);
  });

  it("recusa nicho sem cnae, uf ou cidade — não busca o Brasil inteiro", async () => {
    const campanha = await campanhaComFiltro({
      cnaes: [],
      ufs: [],
      cities: [],
      min_employees: null,
      max_employees: null,
      target_roles: [],
      keywords: ["climatização"],
    });
    const resultado = await descobrirEmpresas({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      apiKey: "chave",
    });
    expect(resultado.motivo).toMatch(/Brasil inteiro/);
  });
});

describe("descobrirEmpresas — caminho feliz", () => {
  it("salva as empresas encontradas e registra o evento", async () => {
    const campanha = await campanhaComFiltro(FILTRO_VALIDO);
    const fetchFn = fetchComPaginas([
      [{ cnpj: "11111111000101" }, { cnpj: "11111111000102" }],
    ]);

    const resultado = await descobrirEmpresas(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKey: "chave",
      },
      { fetch: fetchFn },
    );

    expect(resultado.encontradas).toBe(2);
    expect(resultado.salvas).toBe(2);
    expect(resultado.ignoradas).toBe(0);

    const { rows } = await banco.db.query<{ cnpj: string; source: string }>(
      `select cnpj, source from companies where tenant_id = $1 and campaign_id = $2 order by cnpj`,
      [banco.tenantId, campanha.id],
    );
    expect(rows).toEqual([
      { cnpj: "11111111000101", source: "casa_dos_dados" },
      { cnpj: "11111111000102", source: "casa_dos_dados" },
    ]);

    const { rows: eventos } = await banco.db.query<{ payload: { salvas: number } }>(
      `select payload from events where tenant_id = $1 and kind = 'tentativa_de_descoberta'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(eventos[0]?.payload.salvas).toBe(2);
  });

  it("pagina até a API devolver menos que o tamanho da página", async () => {
    const campanha = await campanhaComFiltro(FILTRO_VALIDO);
    const paginaCheia = Array.from({ length: 100 }, (_, i) => ({
      cnpj: `2${String(i).padStart(13, "0")}`,
    }));
    const fetchFn = fetchComPaginas([paginaCheia, [{ cnpj: "30000000000100" }]]);

    const resultado = await descobrirEmpresas(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKey: "chave",
      },
      { fetch: fetchFn },
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(resultado.encontradas).toBe(101);
    expect(resultado.salvas).toBe(101);
    expect(resultado.paginas).toBe(2);
  });

  it("para de paginar quando a página vem vazia", async () => {
    const campanha = await campanhaComFiltro(FILTRO_VALIDO);
    const fetchFn = fetchComPaginas([[]]);

    const resultado = await descobrirEmpresas(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKey: "chave",
      },
      { fetch: fetchFn },
    );

    expect(resultado.encontradas).toBe(0);
    expect(resultado.motivo).toMatch(/0 encontrada/);
  });

  it("ignora CNPJ já salvo de uma rodada anterior", async () => {
    const campanha = await campanhaComFiltro(FILTRO_VALIDO);
    const primeira = await descobrirEmpresas(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKey: "chave",
      },
      { fetch: fetchComPaginas([[{ cnpj: "40000000000100" }]]) },
    );
    expect(primeira.salvas).toBe(1);

    const segunda = await descobrirEmpresas(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKey: "chave",
      },
      { fetch: fetchComPaginas([[{ cnpj: "40000000000100" }]]) },
    );
    expect(segunda.encontradas).toBe(1);
    expect(segunda.salvas).toBe(0);
    expect(segunda.ignoradas).toBe(1);
  });
});

describe("descobrirEmpresas — falha na busca", () => {
  it("devolve parcial e registra o evento quando a API falha no meio da paginação", async () => {
    const campanha = await campanhaComFiltro(FILTRO_VALIDO);
    // `mockResolvedValue` reaproveitaria a MESMA instância de Response em toda
    // chamada, e um body só pode ser lido uma vez — a página 2 dispara duas
    // tentativas de fetchJson (retry de 500), então cada chamada precisa da
    // sua própria Response.
    let chamada = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      chamada += 1;
      if (chamada === 1) {
        return new Response(
          JSON.stringify({
            total: 100,
            cnpjs: Array.from({ length: 100 }, (_, i) => ({
              cnpj: `5${String(i).padStart(13, "0")}`,
              razao_social: "X",
              nome_fantasia: null,
              endereco: { uf: "SC", municipio: "Joinville" },
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("fora do ar", { status: 500 });
    });

    const resultado = await descobrirEmpresas(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKey: "chave",
      },
      { fetch: fetchFn as unknown as FetchLike },
    );

    expect(resultado.salvas).toBe(100);
    expect(resultado.motivo).toMatch(/Interrompida na página 2/);

    const { rows } = await banco.db.query<{ payload: { pagina: number } }>(
      `select payload from events where tenant_id = $1 and kind = 'falha_na_descoberta'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.payload.pagina).toBe(2);
  });
});
