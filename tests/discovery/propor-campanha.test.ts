import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { criarCampanha, buscarCampanha } from "../../src/db/repositories/campaigns.js";
import {
  proporParaRevisao,
  aprovarPropostaDaCampanha,
} from "../../src/discovery/propor-campanha.js";
import { gerarFiltros } from "../../src/discovery/gerar-filtros.js";
import type { Proposta } from "../../src/ai/proposta.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const PROPOSTA: Proposta = {
  nicho: "indústrias de alimentos em SC com 50 a 200 funcionários",
  oferta: "corta o retrabalho de fechamento mensal em planilha",
  cargos: ["Diretor Industrial", "Gerente de TI"],
  briefing: {
    angulo: "o fechamento mensal consome a equipe inteira",
    dores: ["planilha que ninguém confia"],
    provas: ["FALTA: nenhum número foi informado"],
    evitar: ["prometer prazo"],
  },
  exemplo_de_email: { assunto: "Fechamento na [EMPRESA]", corpo: "Oi [NOME], ..." },
};

async function campanha(nome: string, proposito?: string) {
  return criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    name: nome,
    nicheDescription: proposito ?? "nicho escrito à mão",
    offerDescription: "oferta escrita à mão",
    schedulingLink: "https://cal.com/t/30min",
    senderFirstName: "Thiago",
    solutionPurpose: proposito,
  });
}

describe("proporParaRevisao", () => {
  it("grava a proposta como rascunho, sem tocar no que o funil lê", async () => {
    const c = await campanha("Proposta rascunho", "vendemos BI para indústrias");
    const proporCampanha = vi.fn().mockResolvedValue(PROPOSTA);

    const r = await proporParaRevisao(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { proporCampanha },
    );

    expect(r.proposto).toBe(true);
    expect(proporCampanha).toHaveBeenCalledWith("vendemos BI para indústrias");

    const salva = await buscarCampanha(banco.db, banco.tenantId, c.id);
    expect((salva?.proposal as Proposta).nicho).toBe(PROPOSTA.nicho);
    // Rascunho não promove nada: o funil continua vendo o que via antes.
    expect(salva?.offer_description).toBe("oferta escrita à mão");
    expect(salva?.proposal_approved_at).toBeNull();
  });

  it("usa a descrição do nicho quando não há propósito escrito", async () => {
    // As campanhas criadas antes desta tela existir têm `solution_purpose`
    // nulo. Sem esta queda, o botão só funcionaria em campanha nova.
    const c = await campanha("Sem propósito");
    const proporCampanha = vi.fn().mockResolvedValue(PROPOSTA);

    await proporParaRevisao(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { proporCampanha },
    );

    expect(proporCampanha).toHaveBeenCalledWith("nicho escrito à mão");
  });

  it("recusa campanha inexistente", async () => {
    const r = await proporParaRevisao(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: "99999999-9999-9999-9999-999999999999",
      },
      { proporCampanha: vi.fn() },
    );
    expect(r).toEqual({ proposto: false, motivo: "Campanha não encontrada." });
  });

  it("falha da IA vira motivo e evento, não exceção", async () => {
    const c = await campanha("IA fora do ar", "qualquer coisa");
    const proporCampanha = vi.fn().mockRejectedValue(new Error("modelo indisponível"));

    const r = await proporParaRevisao(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { proporCampanha },
    );

    expect(r.proposto).toBe(false);
    const { rows } = await banco.db.query<{ kind: string }>(
      `select kind from events where tenant_id = $1 and kind = 'falha_ao_propor_campanha'`,
      [banco.tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("aprovarPropostaDaCampanha", () => {
  it("promove nicho, oferta e briefing, e zera os filtros", async () => {
    const c = await campanha("Aprovar", "vendemos BI");
    await proporParaRevisao(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { proporCampanha: vi.fn().mockResolvedValue(PROPOSTA) },
    );

    const r = await aprovarPropostaDaCampanha({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: c.id,
    });

    expect(r).toEqual({ aprovado: true, cargos: PROPOSTA.cargos });

    const salva = await buscarCampanha(banco.db, banco.tenantId, c.id);
    expect(salva?.niche_description).toBe(PROPOSTA.nicho);
    expect(salva?.offer_description).toBe(PROPOSTA.oferta);
    expect(salva?.pitch_briefing).toMatchObject({ angulo: PROPOSTA.briefing.angulo });
    expect(salva?.proposal_approved_at).not.toBeNull();
    // Os filtros vigentes vieram do nicho anterior: mantê-los faria a campanha
    // buscar empresas de um alvo que acabou de ser substituído.
    expect(salva?.filters).toBeNull();
  });

  it("recusa quando não há proposta", async () => {
    const c = await campanha("Sem proposta para aprovar");
    const r = await aprovarPropostaDaCampanha({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: c.id,
    });
    expect(r).toEqual({ aprovado: false, motivo: "Não há proposta para aprovar." });
  });
});

describe("os cargos aprovados vencem os que a IA do nicho propõe", () => {
  const FILTROS_DA_IA = {
    cnaes: ["1091101"],
    ufs: ["SC"],
    cities: [],
    min_employees: null,
    max_employees: null,
    target_roles: ["Comprador", "Analista"],
    keywords: [],
  };

  it("sobrepõe target_roles depois da aprovação", async () => {
    // Sem isto a tela de refino seria teatro: a pessoa editaria "Diretor
    // Industrial" e o funil sairia procurando o que o outro prompt achou.
    const c = await campanha("Cargos vencem", "vendemos BI");
    await proporParaRevisao(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { proporCampanha: vi.fn().mockResolvedValue(PROPOSTA) },
    );
    await aprovarPropostaDaCampanha({
      db: banco.db,
      tenantId: banco.tenantId,
      campaignId: c.id,
    });

    const r = await gerarFiltros(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { parseNiche: vi.fn().mockResolvedValue(FILTROS_DA_IA) },
    );

    expect(r.gerado).toBe(true);
    if (r.gerado) {
      expect(r.filtros.target_roles).toEqual(PROPOSTA.cargos);
      // O resto do que a IA derivou do nicho continua valendo.
      expect(r.filtros.cnaes).toEqual(["1091101"]);
    }
  });

  it("rascunho não aprovado não manda em nada", async () => {
    const c = await campanha("Rascunho não manda", "vendemos BI");
    await proporParaRevisao(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { proporCampanha: vi.fn().mockResolvedValue(PROPOSTA) },
    );

    const r = await gerarFiltros(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { parseNiche: vi.fn().mockResolvedValue(FILTROS_DA_IA) },
    );

    if (r.gerado) expect(r.filtros.target_roles).toEqual(["Comprador", "Analista"]);
  });
});
