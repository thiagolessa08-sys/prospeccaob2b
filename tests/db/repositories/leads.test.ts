import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import {
  criarLead,
  buscarLead,
  transicionarLead,
  incrementarTrocas,
  listarProntosParaContato,
} from "../../../src/db/repositories/leads.js";

let banco: BancoDeTeste;
let empresaId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "77777777000101",
      legalName: "Empresa dos leads",
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
    `select id from companies where cnpj = '77777777000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

let contador = 0;
function novoLead(overrides: Partial<Parameters<typeof criarLead>[1]> = {}) {
  contador += 1;
  return {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: empresaId,
    fullName: "Maria Souza",
    roleTitle: "Gerente de TI",
    email: `maria${contador}@empresa.com.br`,
    emailVerified: true,
    ...overrides,
  };
}

describe("criarLead", () => {
  it("cria o lead já no estágio enriched", async () => {
    const lead = await criarLead(banco.db, novoLead());
    expect(lead.stage).toBe("enriched");
    expect(lead.exchange_count).toBe(0);
    expect(lead.needs_human).toBe(false);
  });
});

describe("transicionarLead", () => {
  it("avança pelo caminho feliz do funil", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const contatado = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "contacted",
    );
    expect(contatado.stage).toBe("contacted");
  });

  it("recusa uma transição inválida antes de tocar o banco", async () => {
    const lead = await criarLead(banco.db, novoLead());
    await expect(
      transicionarLead(banco.db, banco.tenantId, lead.id, "meeting_booked"),
    ).rejects.toThrow(/Transição de estágio inválida/);

    const inalterado = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(inalterado?.stage).toBe("enriched");
  });

  it("grava o motivo do descarte", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const descartado = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "discarded",
      { discardReason: "recusa do lead" },
    );
    expect(descartado.stage).toBe("discarded");
    expect(descartado.discard_reason).toBe("recusa do lead");
  });

  it("marca needs_human junto com o motivo do repasse", async () => {
    const lead = await criarLead(banco.db, novoLead());
    await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted");
    const emConversa = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "in_conversation",
      { needsHuman: true, handoffReason: "conversa longa sem desfecho" },
    );
    expect(emConversa.needs_human).toBe(true);
    expect(emConversa.handoff_reason).toBe("conversa longa sem desfecho");
  });

  it("grava a data de retomada", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const quando = new Date("2026-12-01T12:00:00.000Z");
    await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted", {
      resumeAt: quando,
    });
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido!.resume_at!.toISOString()).toBe(quando.toISOString());
  });

  it("lança quando o lead não existe", async () => {
    await expect(
      transicionarLead(
        banco.db,
        banco.tenantId,
        "99999999-9999-9999-9999-999999999999",
        "contacted",
      ),
    ).rejects.toThrow(/não encontrado/i);
  });
});

describe("incrementarTrocas", () => {
  it("soma um e devolve o valor novo", async () => {
    const lead = await criarLead(banco.db, novoLead());
    expect(await incrementarTrocas(banco.db, banco.tenantId, lead.id)).toBe(1);
    expect(await incrementarTrocas(banco.db, banco.tenantId, lead.id)).toBe(2);
  });
});

describe("listarProntosParaContato", () => {
  it("devolve só leads enriched com e-mail verificado", async () => {
    const verificado = await criarLead(banco.db, novoLead());
    const naoVerificado = await criarLead(
      banco.db,
      novoLead({ emailVerified: false }),
    );
    const jaContatado = await criarLead(banco.db, novoLead());
    await transicionarLead(banco.db, banco.tenantId, jaContatado.id, "contacted");

    const prontos = await listarProntosParaContato(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      50,
    );
    const ids = prontos.map((l) => l.id);
    expect(ids).toContain(verificado.id);
    expect(ids).not.toContain(naoVerificado.id);
    expect(ids).not.toContain(jaContatado.id);
  });

  it("respeita o limite pedido", async () => {
    await criarLead(banco.db, novoLead());
    await criarLead(banco.db, novoLead());
    const prontos = await listarProntosParaContato(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      1,
    );
    expect(prontos).toHaveLength(1);
  });
});
