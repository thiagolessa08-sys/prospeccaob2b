import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { criarCampanha, definirModoDeEnvio } from "../../src/db/repositories/campaigns.js";
import { salvarEmpresas } from "../../src/db/repositories/companies.js";
import {
  criarLead,
  buscarLead,
  transicionarLead,
  atualizarLead,
} from "../../src/db/repositories/leads.js";
import { anexarMensagem } from "../../src/db/repositories/messages.js";
import type { ColdEmailProvider } from "../../src/sending/types.js";
import { retomarFollowups } from "../../src/conversation/retomar-followups.js";

let banco: BancoDeTeste;
let empresaId: string;
let contador = 0;

const base = {
  name: "Retomada",
  nicheDescription: "indústrias",
  offerDescription: "Consultoria de dados e BI",
  schedulingLink: "https://cal.com/thiago/30min",
  senderFirstName: "Thiago",
};

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "88888888000101",
      legalName: "Empresa da Retomada",
      tradeName: null,
      website: null,
      city: null,
      uf: null,
      employeeCount: null,
      summary: null,
      source: "cnpj",
    },
  ]);
  const { rows } = await banco.db.query<{ id: string }>(
    `select id from companies where cnpj = '88888888000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/** Lead em conversa, opcionalmente com um resume_at já definido. */
async function leadEmConversa(opts: { resumeAt?: Date; needsHuman?: boolean } = {}) {
  contador += 1;
  const campanha = await criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    ...base,
    name: `Retomada ${contador}`,
  });
  await definirModoDeEnvio(banco.db, banco.tenantId, campanha.id, "shadow");

  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: campanha.id,
    companyId: empresaId,
    fullName: "Maria Souza",
    roleTitle: "Diretora",
    email: `pessoa${contador}@exemplo.com.br`,
    emailVerified: true,
  });
  await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted");
  await transicionarLead(banco.db, banco.tenantId, lead.id, "in_conversation");

  await anexarMensagem(banco.db, {
    tenantId: banco.tenantId,
    leadId: lead.id,
    direction: "outbound",
    subject: "Integração de dados",
    body: "Olá Maria, vi que a empresa...",
  });
  await anexarMensagem(banco.db, {
    tenantId: banco.tenantId,
    leadId: lead.id,
    direction: "inbound",
    body: "Me procure daqui a uns meses, agora não é o momento.",
    externalId: `evt_${contador}`,
    intent: "not_now",
    confidence: 0.9,
  });

  if (opts.resumeAt || opts.needsHuman) {
    await atualizarLead(banco.db, banco.tenantId, lead.id, {
      resumeAt: opts.resumeAt,
      needsHuman: opts.needsHuman,
    });
  }

  return { campanha, lead };
}

function provedorFalso(
  aoEnviar?: (email: unknown) => { enviado: boolean; motivo?: string },
): ColdEmailProvider & { enviados: unknown[] } {
  const enviados: unknown[] = [];
  return {
    modo: "shadow",
    enviados,
    async enviar(email) {
      enviados.push(email);
      const resultado = aoEnviar?.(email) ?? { enviado: true };
      return resultado.enviado
        ? { enviado: true, externalId: null, sombra: true }
        : { enviado: false, motivo: resultado.motivo ?? "falha qualquer" };
    },
    async contarBounces() {
      return null;
    },
  };
}

function depsComRascunho(rascunho = { subject: "Re: retomando", body: "Oi de novo!" }) {
  return { escreverFollowup: vi.fn().mockResolvedValue(rascunho) };
}

describe("retomarFollowups — casos de entrada", () => {
  it("recusa campanha inexistente", async () => {
    const resultado = await retomarFollowups(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: "99999999-9999-9999-9999-999999999999",
        provedor: provedorFalso(),
      },
      depsComRascunho(),
    );
    expect(resultado).toEqual({
      processados: 0,
      enviados: 0,
      falhas: 0,
      motivo: "Campanha não encontrada.",
    });
  });

  it("não faz nada sem lead com retomada vencida", async () => {
    const { campanha } = await leadEmConversa();
    const resultado = await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      depsComRascunho(),
    );
    expect(resultado.processados).toBe(0);
  });

  it("ignora lead com resume_at no futuro", async () => {
    const { campanha } = await leadEmConversa({
      resumeAt: new Date(Date.now() + 30 * UM_DIA_MS),
    });
    const resultado = await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      depsComRascunho(),
    );
    expect(resultado.processados).toBe(0);
  });

  it("ignora lead repassado a humano, mesmo com retomada vencida", async () => {
    const { campanha } = await leadEmConversa({
      resumeAt: new Date(Date.now() - UM_DIA_MS),
      needsHuman: true,
    });
    const resultado = await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      depsComRascunho(),
    );
    expect(resultado.processados).toBe(0);
  });
});

describe("retomarFollowups — caminho feliz", () => {
  it("envia o follow-up e limpa a retomada", async () => {
    const { campanha, lead } = await leadEmConversa({
      resumeAt: new Date(Date.now() - UM_DIA_MS),
    });
    const provedor = provedorFalso();
    const resultado = await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      depsComRascunho(),
    );

    expect(resultado).toEqual({
      processados: 1,
      enviados: 1,
      falhas: 0,
      motivo: "Processados 1, 1 follow-up(s) enviado(s), 0 falha(s).",
    });
    expect(provedor.enviados).toHaveLength(1);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.resume_at).toBeNull();
    expect(relido?.stage).toBe("in_conversation");
  });

  it("não reenvia numa segunda varredura, já que a retomada foi limpa", async () => {
    const { campanha } = await leadEmConversa({
      resumeAt: new Date(Date.now() - UM_DIA_MS),
    });
    const d = depsComRascunho();
    await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      d,
    );
    const segunda = await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      d,
    );
    expect(segunda.processados).toBe(0);
    expect(d.escreverFollowup).toHaveBeenCalledTimes(1);
  });
});

describe("retomarFollowups — falhas", () => {
  it("limpa a retomada mesmo quando o envio falha, para não reprocessar para sempre", async () => {
    const { campanha, lead } = await leadEmConversa({
      resumeAt: new Date(Date.now() - UM_DIA_MS),
    });
    const provedor = provedorFalso(() => ({ enviado: false, motivo: "endereço inválido" }));
    const resultado = await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      depsComRascunho(),
    );

    expect(resultado.falhas).toBe(1);
    expect(resultado.enviados).toBe(0);
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.resume_at).toBeNull();
  });

  it("repassa a humano quando a IA falha, e segue para o próximo lead", async () => {
    // Prazos diferentes garantem a ordem: `listarProntosParaRetomar` ordena
    // por `resume_at`, e o teste precisa saber qual lead o mock de IA atende
    // primeiro.
    const { campanha, lead: leadQueFalha } = await leadEmConversa({
      resumeAt: new Date(Date.now() - 2 * UM_DIA_MS),
    });
    const { lead: leadOk } = await leadEmConversa({
      resumeAt: new Date(Date.now() - UM_DIA_MS),
    });
    // as duas campanhas são distintas — precisa da mesma para o lote enxergar
    // os dois leads numa chamada só.
    await banco.db.query(`update leads set campaign_id = $1 where id = $2`, [
      campanha.id,
      leadOk.id,
    ]);

    const d = { escreverFollowup: vi.fn() };
    d.escreverFollowup
      .mockRejectedValueOnce(new Error("Claude fora do ar"))
      .mockResolvedValueOnce({ subject: "Re: retomando", body: "Oi de novo!" });

    const provedor = provedorFalso();
    const resultado = await retomarFollowups(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      d,
    );

    expect(resultado.processados).toBe(2);
    expect(resultado.enviados).toBe(1);
    expect(resultado.falhas).toBe(1);

    const relidoFalha = await buscarLead(banco.db, banco.tenantId, leadQueFalha.id);
    expect(relidoFalha?.needs_human).toBe(true);
    expect(relidoFalha?.handoff_reason).toContain("Claude fora do ar");
    expect(relidoFalha?.resume_at).toBeNull();
  });
});
