import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import {
  criarCampanha,
  salvarFiltros,
} from "../../src/db/repositories/campaigns.js";
import { salvarEmpresas } from "../../src/db/repositories/companies.js";
import { enriquecerLote } from "../../src/enrichment/enriquecer-lote.js";
import type { DepsEnriquecimento } from "../../src/enrichment/chain.js";
import type { DadosDaEmpresa } from "../../src/enrichment/types.js";

let banco: BancoDeTeste;
let contador = 0;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const base = {
  name: "Enriquecimento",
  nicheDescription: "indústrias",
  offerDescription: "BI",
  schedulingLink: "https://cal.com/t/30min",
  senderFirstName: "Thiago",
};

const EMPRESA: DadosDaEmpresa = {
  cnpj: "12222222000101",
  razaoSocial: "ALFA LTDA",
  nomeFantasia: "ALFA",
  cnaePrincipal: "1091101",
  descricaoCnae: "Panificação industrial",
  uf: "SC",
  municipio: "JOINVILLE",
  porte: "DEMAIS",
  ativa: true,
  email: null,
  telefone: null,
  socios: [{ nome: "MARIA SOUZA", qualificacao: "Administrador" }],
};

function depsQueAcham(): DepsEnriquecimento {
  return {
    buscarEmpresa: vi.fn().mockResolvedValue(EMPRESA),
    acharPorNome: vi.fn().mockResolvedValue({
      nome: "Maria Souza",
      cargo: "Administradora",
      email: "maria@alfa.com.br",
      confianca: 90,
      verificacao: "valid",
      fonte: "hunter_finder",
    }),
    buscarDominio: vi.fn().mockResolvedValue([]),
    verificar: vi.fn().mockResolvedValue({ status: "valid", score: 90 }),
  };
}

function depsQueNaoAcham(): DepsEnriquecimento {
  return {
    buscarEmpresa: vi.fn().mockResolvedValue(EMPRESA),
    acharPorNome: vi.fn().mockResolvedValue(null),
    buscarDominio: vi.fn().mockResolvedValue([]),
    verificar: vi.fn().mockResolvedValue({ status: "valid", score: 90 }),
  };
}

/** Cria uma campanha com N empresas pendentes de enriquecimento. */
async function cenario(cnpjs: string[]) {
  contador += 1;
  const campanha = await criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    ...base,
    name: `Enriquecimento ${contador}`,
  });
  await salvarEmpresas(
    banco.db,
    cnpjs.map((cnpj, i) => ({
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      cnpj,
      legalName: `Empresa ${contador}-${i}`,
      tradeName: null,
      // `null` de propósito: é o que a descoberta pela Casa dos Dados grava,
      // já que a busca avançada de lá não devolve site. Fixar um site aqui
      // foi o que escondeu, por um commit inteiro, o fato de a cadeia
      // desistir de toda empresa sem domínio.
      website: null,
      city: null,
      uf: null,
      employeeCount: null,
      summary: null,
      source: "cnpj",
    })),
  );
  return campanha;
}

describe("enriquecerLote — casos de entrada", () => {
  it("recusa campanha inexistente", async () => {
    const resultado = await enriquecerLote({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: "99999999-9999-9999-9999-999999999999",
      apiKeyHunter: "chave",
    });
    expect(resultado).toEqual({
      processadas: 0,
      encontrados: 0,
      falhas: 0,
      motivo: "Campanha não encontrada.",
    });
  });

  it("não faz nada quando não há empresa pendente", async () => {
    const campanha = await cenario([]);
    const resultado = await enriquecerLote({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      apiKeyHunter: "chave",
    });
    expect(resultado.processadas).toBe(0);
  });
});

describe("enriquecerLote — caminho feliz", () => {
  it("acha o decisor, cria o lead e marca a empresa como enriquecida", async () => {
    const campanha = await cenario(["13333333000101"]);
    const resultado = await enriquecerLote(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKeyHunter: "chave",
      },
      depsQueAcham(),
    );

    expect(resultado).toEqual({
      processadas: 1,
      encontrados: 1,
      falhas: 0,
      motivo: "Processadas 1, 1 decisor(es) encontrado(s), 0 falha(s).",
    });

    const { rows: leads } = await banco.db.query<{ email: string }>(
      `select email from leads where tenant_id = $1 and campaign_id = $2`,
      [banco.tenantId, campanha.id],
    );
    expect(leads[0]?.email).toBe("maria@alfa.com.br");

    const { rows: empresas } = await banco.db.query<{
      enrichment_status: string;
    }>(
      `select enrichment_status from companies
       where tenant_id = $1 and cnpj = '13333333000101'`,
      [banco.tenantId],
    );
    expect(empresas[0]?.enrichment_status).toBe("enriched");
  });

  it("registra a tentativa em events mesmo quando acha", async () => {
    const campanha = await cenario(["14444444000101"]);
    await enriquecerLote(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKeyHunter: "chave",
      },
      depsQueAcham(),
    );

    const { rows } = await banco.db.query<{ payload: { achou: boolean } }>(
      `select payload from events
       where tenant_id = $1 and kind = 'tentativa_de_enriquecimento'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.payload.achou).toBe(true);
  });

  it("usa o alvo derivado dos filtros da campanha", async () => {
    const campanha = await cenario(["15555555000101"]);
    await salvarFiltros(banco.db, banco.tenantId, campanha.id, {
      cnaes: [],
      ufs: [],
      cities: [],
      min_employees: null,
      max_employees: null,
      target_roles: ["Gerente de TI"],
      keywords: [],
    });

    const deps = depsQueNaoAcham();
    await enriquecerLote(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKeyHunter: "chave",
      },
      deps,
    );

    // "Gerente de TI" mapeia para cargo_funcional/it: a cadeia deve ter caído
    // direto na busca por domínio, sem tentar o nome do sócio.
    expect(deps.acharPorNome).not.toHaveBeenCalled();
    expect(deps.buscarDominio).toHaveBeenCalledWith(
      expect.objectContaining({ departamento: "it" }),
    );
  });
});

describe("enriquecerLote — falhas", () => {
  it("marca como failed e conta como falha quando não acha ninguém", async () => {
    const campanha = await cenario(["16666666000101"]);
    const resultado = await enriquecerLote(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKeyHunter: "chave",
      },
      depsQueNaoAcham(),
    );

    expect(resultado.encontrados).toBe(0);
    expect(resultado.falhas).toBe(1);

    const { rows } = await banco.db.query<{ enrichment_status: string }>(
      `select enrichment_status from companies
       where tenant_id = $1 and cnpj = '16666666000101'`,
      [banco.tenantId],
    );
    expect(rows[0]?.enrichment_status).toBe("failed");
  });

  it("marca como failed uma empresa sem CNPJ, sem gastar chamada nenhuma", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: `Sem CNPJ ${++contador}`,
    });
    await salvarEmpresas(banco.db, [
      {
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        cnpj: null,
        legalName: "Empresa sem CNPJ",
        tradeName: null,
        website: null,
        city: null,
        uf: null,
        employeeCount: null,
        summary: null,
        source: "maps",
      },
    ]);

    const deps = depsQueAcham();
    const resultado = await enriquecerLote(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKeyHunter: "chave",
      },
      deps,
    );

    expect(resultado.falhas).toBe(1);
    expect(deps.buscarEmpresa).not.toHaveBeenCalled();
  });

  it("continua para a próxima empresa quando uma lança no meio do lote", async () => {
    const campanha = await cenario(["17777777000101", "17777777000102"]);
    let primeira = true;
    const deps: DepsEnriquecimento = {
      buscarEmpresa: vi.fn().mockImplementation(async () => {
        if (primeira) {
          primeira = false;
          throw new Error("BrasilAPI fora do ar");
        }
        return EMPRESA;
      }),
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria2@alfa.com.br",
        confianca: 90,
        verificacao: "valid",
        fonte: "hunter_finder",
      }),
      buscarDominio: vi.fn().mockResolvedValue([]),
      verificar: vi.fn().mockResolvedValue({ status: "valid", score: 90 }),
    };

    const resultado = await enriquecerLote(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        apiKeyHunter: "chave",
      },
      deps,
    );

    expect(resultado.processadas).toBe(2);
    expect(resultado.encontrados + resultado.falhas).toBe(2);
  });
});
