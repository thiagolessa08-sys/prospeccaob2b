import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import {
  criarLead,
  buscarLead,
  transicionarLead,
} from "../../../src/db/repositories/leads.js";
import { carregarConversa } from "../../../src/db/repositories/messages.js";
import { carregarRegrasDeSupressao } from "../../../src/db/repositories/suppression.js";
import {
  tratarWebhookInstantly,
  HEADER_SEGREDO,
} from "../../../src/api/handlers/instantly-webhook.js";

const SEGREDO = "segredo-instantly";

let banco: BancoDeTeste;
let empresaId: string;
let contador = 0;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "97777777000101",
      legalName: "Empresa do webhook",
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
    `select id from companies where cnpj = '97777777000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

async function leadContatado(email: string) {
  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: empresaId,
    fullName: "Pessoa do Webhook",
    roleTitle: "Gerente",
    email,
    emailVerified: true,
  });
  await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted");
  return lead;
}

function deps() {
  return { db: banco.db, tenantId: banco.tenantId, segredo: SEGREDO };
}

function requisicao(corpo: unknown, segredo: string | null = SEGREDO) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (segredo !== null) headers[HEADER_SEGREDO] = segredo;
  return new Request("https://x/webhooks/instantly", {
    method: "POST",
    headers,
    body: JSON.stringify(corpo),
  });
}

function respostaRecebida(email: string, overrides: Record<string, unknown> = {}) {
  contador += 1;
  return {
    event_type: "reply_received",
    timestamp: "2026-08-31T12:00:00.000Z",
    campaign_id: "camp-instantly",
    lead_email: email,
    email_account: "thiago@sqltech.net.br",
    email_id: `evt_${contador}`,
    reply_subject: "Re: Integração de dados",
    reply_text: "Interessante, pode me mandar mais detalhes?",
    reply_html: "<p>Interessante</p>",
    is_first: true,
    step: 1,
    ...overrides,
  };
}

describe("autenticação", () => {
  it("recusa com 401 quando o segredo está ausente", async () => {
    const res = await tratarWebhookInstantly(
      requisicao(respostaRecebida("a@b.com"), null),
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("recusa com 401 quando o segredo está errado", async () => {
    const res = await tratarWebhookInstantly(
      requisicao(respostaRecebida("a@b.com"), "errado"),
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("recusa com 401 antes de tocar o banco", async () => {
    const lead = await leadContatado("naotocado@exemplo.com");
    await tratarWebhookInstantly(
      requisicao(respostaRecebida("naotocado@exemplo.com"), "errado"),
      deps(),
    );
    const conversa = await carregarConversa(banco.db, banco.tenantId, lead.id);
    expect(conversa).toHaveLength(0);
  });
});

describe("corpo malformado", () => {
  it("devolve 400 para JSON inválido, nunca 5xx", async () => {
    const req = new Request("https://x/webhooks/instantly", {
      method: "POST",
      headers: { [HEADER_SEGREDO]: SEGREDO },
      body: "{isto não é json",
    });
    const res = await tratarWebhookInstantly(req, deps());
    expect(res.status).toBe(400);
  });

  it("devolve 400 quando falta event_type", async () => {
    const res = await tratarWebhookInstantly(
      requisicao({ lead_email: "a@b.com" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("reply_received", () => {
  it("grava a resposta e move o lead para in_conversation", async () => {
    const lead = await leadContatado("resposta@exemplo.com");
    const res = await tratarWebhookInstantly(
      requisicao(respostaRecebida("resposta@exemplo.com")),
      deps(),
    );
    expect(res.status).toBe(200);

    const conversa = await carregarConversa(banco.db, banco.tenantId, lead.id);
    expect(conversa).toHaveLength(1);
    expect(conversa[0]!.direction).toBe("inbound");
    expect(conversa[0]!.body).toContain("mais detalhes");
    expect(conversa[0]!.subject).toBe("Re: Integração de dados");

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("in_conversation");
  });

  it("é idempotente: a reentrega não grava segunda mensagem", async () => {
    const lead = await leadContatado("reentrega@exemplo.com");
    const corpo = respostaRecebida("reentrega@exemplo.com");

    const primeira = await tratarWebhookInstantly(requisicao(corpo), deps());
    const segunda = await tratarWebhookInstantly(requisicao(corpo), deps());

    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);

    const conversa = await carregarConversa(banco.db, banco.tenantId, lead.id);
    expect(conversa).toHaveLength(1);
  });

  it("aceita resposta de lead já em conversa, sem falhar a transição", async () => {
    const lead = await leadContatado("segunda@exemplo.com");
    await tratarWebhookInstantly(
      requisicao(respostaRecebida("segunda@exemplo.com")),
      deps(),
    );
    const res = await tratarWebhookInstantly(
      requisicao(respostaRecebida("segunda@exemplo.com")),
      deps(),
    );
    expect(res.status).toBe(200);

    const conversa = await carregarConversa(banco.db, banco.tenantId, lead.id);
    expect(conversa).toHaveLength(2);
  });

  it("responde 200 e registra evento quando nenhum lead casa", async () => {
    const res = await tratarWebhookInstantly(
      requisicao(respostaRecebida("desconhecido@exemplo.com")),
      deps(),
    );
    expect(res.status).toBe(200);

    const { rows } = await banco.db.query<{ kind: string }>(
      `select kind from events where tenant_id = $1 and kind = 'webhook_sem_lead'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.kind).toBe("webhook_sem_lead");
  });
});

describe("email_bounced", () => {
  it("marca o bounce, descarta o lead e suprime o endereço para o futuro", async () => {
    const lead = await leadContatado("quebrou@exemplo.com");
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "email_bounced",
        lead_email: "quebrou@exemplo.com",
        campaign_id: "camp",
        email_id: "evt_bounce_1",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.bounced_at).toBeInstanceOf(Date);
    expect(relido?.stage).toBe("discarded");
    expect(relido?.discard_reason).toMatch(/bounce/i);

    // A supressão vale para qualquer campanha futura, não só para descartar
    // este lead — é o que impede um endereço já provado inválido de ser
    // tentado de novo se outra empresa aparecer com o mesmo e-mail.
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({ kind: "email", value: "quebrou@exemplo.com" });
  });

  it("suprime mesmo sem lead casado", async () => {
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "email_bounced",
        lead_email: "fantasma-bounce@exemplo.com",
        campaign_id: "camp",
        email_id: "evt_bounce_fantasma",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({
      kind: "email",
      value: "fantasma-bounce@exemplo.com",
    });
  });

  it("nunca devolve 5xx para lead_email malformado, mesmo sem conseguir suprimir", async () => {
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "email_bounced",
        lead_email: "isto-nao-e-email",
        campaign_id: "camp",
        email_id: "evt_bounce_malformado",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const { rows } = await banco.db.query<{ kind: string }>(
      `select kind from events where tenant_id = $1 and kind = 'webhook_email_invalido'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.kind).toBe("webhook_email_invalido");
  });
});

describe("lead_unsubscribed", () => {
  it("suprime o endereço para sempre e descarta o lead", async () => {
    const lead = await leadContatado("saiu@exemplo.com");
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "lead_unsubscribed",
        lead_email: "saiu@exemplo.com",
        campaign_id: "camp",
        email_id: "evt_unsub_1",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({ kind: "email", value: "saiu@exemplo.com" });

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("discarded");
  });

  it("suprime mesmo quando nenhum lead casa", async () => {
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "lead_unsubscribed",
        lead_email: "fantasma@exemplo.com",
        campaign_id: "camp",
        email_id: "evt_unsub_2",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({
      kind: "email",
      value: "fantasma@exemplo.com",
    });
  });

  it("nunca devolve 5xx para lead_email malformado", async () => {
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "lead_unsubscribed",
        lead_email: "isto-nao-e-email",
        campaign_id: "camp",
        email_id: "evt_unsub_malformado",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const { rows } = await banco.db.query<{ kind: string }>(
      `select kind from events where tenant_id = $1 and kind = 'webhook_email_invalido'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.kind).toBe("webhook_email_invalido");
  });
});

describe("eventos que não tratamos", () => {
  it("responde 200 para auto_reply_received sem gravar mensagem", async () => {
    const lead = await leadContatado("ferias@exemplo.com");
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "auto_reply_received",
        lead_email: "ferias@exemplo.com",
        campaign_id: "camp",
        email_id: "evt_auto_1",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const conversa = await carregarConversa(banco.db, banco.tenantId, lead.id);
    expect(conversa).toHaveLength(0);
  });

  it("responde 200 para um evento desconhecido", async () => {
    const res = await tratarWebhookInstantly(
      requisicao({
        event_type: "algo_que_nao_conhecemos",
        lead_email: "x@exemplo.com",
        campaign_id: "camp",
      }),
      deps(),
    );
    expect(res.status).toBe(200);
  });
});
