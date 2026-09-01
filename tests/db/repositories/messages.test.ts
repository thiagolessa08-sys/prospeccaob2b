import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  subirBanco,
  criarTenantVizinho,
  type BancoDeTeste,
} from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import { criarLead } from "../../../src/db/repositories/leads.js";
import {
  anexarMensagem,
  carregarConversa,
  atualizarClassificacao,
} from "../../../src/db/repositories/messages.js";

let banco: BancoDeTeste;
let leadId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "88888888000101",
      legalName: "Empresa das mensagens",
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
  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: rows[0]!.id,
    fullName: "João",
    roleTitle: "Diretor",
    email: "joao@mensagens.com.br",
    emailVerified: true,
  });
  leadId = lead.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

describe("anexarMensagem", () => {
  it("grava uma mensagem enviada", async () => {
    const msg = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "outbound",
      subject: "Integração de dados",
      body: "Olá João...",
    });
    expect(msg?.direction).toBe("outbound");
    expect(msg?.subject).toBe("Integração de dados");
  });

  it("grava a classificação junto da mensagem recebida", async () => {
    const msg = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "Quanto custa?",
      intent: "question_or_objection",
      confidence: 0.91,
      aiReasoning: "Perguntou preço antes de aceitar conversar.",
      externalId: "evt_classificada",
    });
    expect(msg?.intent).toBe("question_or_objection");
    // `confidence` é `numeric`, e nenhum driver converte `numeric` para
    // número: o que volta é a string exata que o Postgres guardou. Quem for
    // comparar com um limiar precisa converter antes.
    expect(msg?.confidence).toBe("0.91");
    expect(Number(msg?.confidence)).toBe(0.91);
    expect(msg?.ai_reasoning).toContain("preço");
  });

  it("devolve null na reentrega do mesmo webhook, em vez de lançar", async () => {
    const primeira = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "mensagem única",
      externalId: "evt_unico",
    });
    expect(primeira).not.toBeNull();

    const repetida = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "mensagem única",
      externalId: "evt_unico",
    });
    expect(repetida).toBeNull();
  });

  it("permite várias mensagens sem external_id", async () => {
    const a = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "outbound",
      body: "follow-up um",
    });
    const b = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "outbound",
      body: "follow-up dois",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("lança em lead de outro tenant, sem confundir com reentrega", async () => {
    const vizinho = await criarTenantVizinho(banco.db, "0003");

    await expect(
      anexarMensagem(banco.db, {
        tenantId: banco.tenantId,
        leadId: vizinho.leadId,
        direction: "inbound",
        body: "mensagem cruzada",
        externalId: "evt_cruzado",
      }),
    ).rejects.toThrow(/não pertence ao tenant/i);

    // Lançar, e não devolver `null`: `null` faria o chamador responder 2xx ao
    // Instantly e a resposta do lead sumiria em silêncio.
    const { rows } = await banco.db.query(
      `select 1 from messages where external_id = 'evt_cruzado'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("carregarConversa", () => {
  it("devolve as mensagens do lead em ordem cronológica", async () => {
    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    expect(conversa.length).toBeGreaterThan(1);
    for (let i = 1; i < conversa.length; i++) {
      expect(conversa[i]!.created_at.getTime()).toBeGreaterThanOrEqual(
        conversa[i - 1]!.created_at.getTime(),
      );
    }
  });

  it("devolve lista vazia para lead sem mensagens", async () => {
    const conversa = await carregarConversa(
      banco.db,
      banco.tenantId,
      "99999999-9999-9999-9999-999999999999",
    );
    expect(conversa).toEqual([]);
  });
});

describe("atualizarClassificacao", () => {
  it("grava intent, confidence e ai_reasoning numa mensagem existente", async () => {
    const gravada = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "Quero marcar uma conversa.",
    });
    await atualizarClassificacao(banco.db, banco.tenantId, gravada!.id, {
      intent: "interested",
      confidence: 0.92,
      aiReasoning: "Pediu para conversar.",
    });

    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    const relida = conversa.find((m) => m.id === gravada!.id);
    expect(relida?.intent).toBe("interested");
    expect(Number(relida?.confidence)).toBeCloseTo(0.92);
    expect(relida?.ai_reasoning).toBe("Pediu para conversar.");
  });

  it("não afeta mensagem de outro tenant", async () => {
    const gravada = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "Mensagem para não vazar.",
    });
    const vizinho = await criarTenantVizinho(banco.db, "0aa2");
    await atualizarClassificacao(banco.db, vizinho.tenantId, gravada!.id, {
      intent: "no",
      confidence: 0.5,
      aiReasoning: "não deveria gravar",
    });

    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    const relida = conversa.find((m) => m.id === gravada!.id);
    expect(relida?.intent).toBeNull();
  });
});
