import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import {
  criarCampanha,
  definirModoDeEnvio,
} from "../../src/db/repositories/campaigns.js";
import { salvarEmpresas } from "../../src/db/repositories/companies.js";
import {
  criarLead,
  buscarLead,
  transicionarLead,
} from "../../src/db/repositories/leads.js";
import {
  anexarMensagem,
  carregarConversa,
} from "../../src/db/repositories/messages.js";
import { carregarRegrasDeSupressao } from "../../src/db/repositories/suppression.js";
import { criarProvedorDeSombra } from "../../src/sending/shadow.js";
import type { ColdEmailProvider } from "../../src/sending/types.js";
import { processarResposta } from "../../src/conversation/processar-resposta.js";
import type { ReplyClassification } from "../../src/ai/reply-classifier.js";

let banco: BancoDeTeste;
let empresaId: string;
let contador = 0;

const base = {
  name: "Conversa",
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
      cnpj: "99999999000101",
      legalName: "Empresa da Conversa",
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
    `select id from companies where cnpj = '99999999000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

/** Lead em conversa, com uma resposta recebida ainda não classificada. */
async function leadComResposta(corpoDaResposta: string) {
  contador += 1;
  const campanha = await criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    ...base,
    name: `Conversa ${contador}`,
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
    body: corpoDaResposta,
    externalId: `evt_${contador}`,
  });

  return { campanha, lead };
}

function classificacao(overrides: Partial<ReplyClassification> = {}): ReplyClassification {
  return {
    intent: "interested",
    confidence: 0.95,
    reasoning: "motivo qualquer",
    key_points: [],
    suggested_resume_days: null,
    ...overrides,
  };
}

function provedorFalso(): ColdEmailProvider & { enviados: unknown[] } {
  const enviados: unknown[] = [];
  return {
    modo: "shadow",
    enviados,
    async enviar(email) {
      enviados.push(email);
      return { enviado: true, externalId: null, sombra: true };
    },
    async contarBounces() {
      return null;
    },
  };
}

function deps(classificar: ReplyClassification) {
  return {
    classificar: vi.fn().mockResolvedValue(classificar),
    escreverReply: vi
      .fn()
      .mockResolvedValue({ subject: "Re: Integração", body: "Corpo da réplica" }),
  };
}

describe("processarResposta — casos de entrada", () => {
  it("recusa quando o lead não existe", async () => {
    const resultado = await processarResposta({
      db: banco.db,
      tenantId: banco.tenantId,
      leadId: "99999999-9999-9999-9999-999999999999",
      provedor: provedorFalso(),
    });
    expect(resultado).toEqual({
      processado: false,
      motivo: "Lead não encontrado.",
    });
  });

  it("não faz nada quando não há resposta pendente de classificação", async () => {
    const { lead } = await leadComResposta("Interessante, me conta mais.");
    const d = deps(classificacao());
    await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor: provedorFalso() },
      d,
    );
    // a primeira chamada classificou a única mensagem pendente; a segunda não
    // deve achar nada para fazer.
    const resultado = await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor: provedorFalso() },
      d,
    );
    expect(resultado.processado).toBe(false);
    expect(d.classificar).toHaveBeenCalledTimes(1);
  });
});

describe("processarResposta — interesse", () => {
  it("envia o link de agendamento e conta a troca", async () => {
    const { lead } = await leadComResposta("Podemos marcar uma conversa?");
    const provedor = provedorFalso();
    const resultado = await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor },
      deps(classificacao({ intent: "interested" })),
    );

    expect(resultado).toEqual({ processado: true, acao: "send_scheduling_link" });
    expect(provedor.enviados).toHaveLength(1);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.exchange_count).toBe(1);

    const conversa = await carregarConversa(banco.db, banco.tenantId, lead.id);
    const recebida = conversa.find((m) => m.direction === "inbound");
    expect(recebida?.intent).toBe("interested");
    expect(Number(recebida?.confidence)).toBeCloseTo(0.95);
  });
});

describe("processarResposta — dúvida", () => {
  it("responde e conduz, sem mudar o estágio", async () => {
    const { lead } = await leadComResposta("Quanto custa isso?");
    const resultado = await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor: provedorFalso() },
      deps(classificacao({ intent: "question_or_objection", key_points: ["preço"] })),
    );
    expect(resultado).toEqual({ processado: true, acao: "answer_and_nudge" });

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("in_conversation");
  });
});

describe("processarResposta — não agora", () => {
  it("agenda a retomada no prazo que o lead pediu", async () => {
    const { lead } = await leadComResposta("Me procure daqui a duas semanas.");
    await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor: provedorFalso() },
      deps(classificacao({ intent: "not_now", suggested_resume_days: 14 })),
    );

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.resume_at).toBeInstanceOf(Date);
    const dias =
      (relido!.resume_at!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(dias).toBeGreaterThan(13);
    expect(dias).toBeLessThan(15);
  });
});

describe("processarResposta — recusa e descadastro", () => {
  it("encerra com despedida numa recusa simples, sem suprimir", async () => {
    const { lead } = await leadComResposta("Não temos interesse, obrigado.");
    const provedor = provedorFalso();
    await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor },
      deps(classificacao({ intent: "no" })),
    );

    expect(provedor.enviados).toHaveLength(1);
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("discarded");

    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).not.toContainEqual({ kind: "email", value: lead.email });
  });

  it("suprime sem enviar nada num pedido de descadastro", async () => {
    const { lead } = await leadComResposta("Para de me mandar e-mail.");
    const provedor = provedorFalso();
    await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor },
      deps(classificacao({ intent: "opt_out" })),
    );

    expect(provedor.enviados).toHaveLength(0);
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("discarded");

    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({ kind: "email", value: lead.email });
  });
});

describe("processarResposta — repasse a humano", () => {
  it("marca needs_human sem enviar nada nem mudar o estágio", async () => {
    const { lead } = await leadComResposta("Texto bem ambíguo e confuso.");
    const provedor = provedorFalso();
    await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor },
      deps(classificacao({ confidence: 0.2 })),
    );

    expect(provedor.enviados).toHaveLength(0);
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.needs_human).toBe(true);
    expect(relido?.stage).toBe("in_conversation");
  });

  it("não responde mais depois de já ter sido entregue a um humano", async () => {
    const { lead } = await leadComResposta("Primeira mensagem ambígua.");
    const provedor = provedorFalso();
    await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor },
      deps(classificacao({ confidence: 0.2 })),
    );

    // uma segunda resposta chega depois do repasse
    await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "inbound",
      body: "Segunda mensagem, agora bem clara: quero marcar.",
      externalId: `evt_seguinte_${contador}`,
    });

    await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor },
      deps(classificacao({ intent: "interested", confidence: 0.98 })),
    );

    // needs_human continua true e nada foi enviado, mesmo com confiança alta
    // na segunda classificação — a trava do domínio decide antes disso.
    expect(provedor.enviados).toHaveLength(0);
  });
});

describe("processarResposta — falha na etapa de ação", () => {
  it("vira repasse a humano em vez de perder a resposta em silêncio", async () => {
    const { lead } = await leadComResposta("Quero marcar uma conversa.");
    const d = deps(classificacao({ intent: "interested" }));
    d.escreverReply.mockRejectedValue(new Error("Claude fora do ar"));

    const resultado = await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor: provedorFalso() },
      d,
    );

    expect(resultado).toEqual({ processado: true, acao: "handoff_to_human" });

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.needs_human).toBe(true);
    expect(relido?.handoff_reason).toContain("Claude fora do ar");

    // a mensagem já foi classificada, então um reprocessamento não a acharia
    // de novo — é exatamente por isso que a falha não pode ficar em silêncio.
    const conversa = await carregarConversa(banco.db, banco.tenantId, lead.id);
    const recebida = conversa.find((m) => m.direction === "inbound");
    expect(recebida?.intent).toBe("interested");
  });
});

describe("processarResposta — fora do escopo", () => {
  it("ignora sem enviar nada e sem mudar o estágio", async () => {
    const { lead } = await leadComResposta("Estou de férias até dia 20.");
    const provedor = provedorFalso();
    const resultado = await processarResposta(
      { db: banco.db, tenantId: banco.tenantId, leadId: lead.id, provedor },
      deps(classificacao({ intent: "out_of_scope" })),
    );

    expect(resultado).toEqual({ processado: true, acao: "ignore" });
    expect(provedor.enviados).toHaveLength(0);
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("in_conversation");
  });
});
