import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import {
  criarLead,
  buscarLead,
  transicionarLead,
} from "../../../src/db/repositories/leads.js";
import {
  tratarWebhookCalcom,
  HEADER_ASSINATURA,
} from "../../../src/api/handlers/calcom-webhook.js";

const SEGREDO = "segredo-calcom";

let banco: BancoDeTeste;
let empresaId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "98888888000101",
      legalName: "Empresa do Cal",
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
    `select id from companies where cnpj = '98888888000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

async function leadNoEstagio(email: string, ate: "contacted" | "in_conversation") {
  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: empresaId,
    fullName: "Pessoa do Cal",
    roleTitle: "Diretora",
    email,
    emailVerified: true,
  });
  await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted");
  if (ate === "in_conversation") {
    await transicionarLead(banco.db, banco.tenantId, lead.id, "in_conversation");
  }
  return lead;
}

function deps() {
  return { db: banco.db, tenantId: banco.tenantId, segredo: SEGREDO };
}

function agendamento(email: string, overrides: Record<string, unknown> = {}) {
  return {
    triggerEvent: "BOOKING_CREATED",
    createdAt: "2026-08-31T12:00:00.000Z",
    payload: {
      uid: "bkg_abc123",
      type: "reuniao-30min",
      startTime: "2026-09-05T14:00:00.000Z",
      endTime: "2026-09-05T14:30:00.000Z",
      attendees: [{ email, name: "Pessoa do Cal", timeZone: "America/Sao_Paulo" }],
      organizer: { name: "Thiago", email: "thiago@sqltech.com.br" },
      ...overrides,
    },
  };
}

function requisicao(corpo: unknown, segredo: string | null = SEGREDO) {
  const bruto = JSON.stringify(corpo);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (segredo !== null) {
    headers[HEADER_ASSINATURA] = createHmac("sha256", segredo)
      .update(bruto)
      .digest("hex");
  }
  return new Request("https://x/webhooks/calcom", {
    method: "POST",
    headers,
    body: bruto,
  });
}

describe("autenticação", () => {
  it("recusa com 401 sem assinatura", async () => {
    const res = await tratarWebhookCalcom(
      requisicao(agendamento("a@b.com"), null),
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("recusa com 401 assinatura de outro segredo", async () => {
    const res = await tratarWebhookCalcom(
      requisicao(agendamento("a@b.com"), "outro-segredo"),
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("recusa quando o corpo foi adulterado depois de assinado", async () => {
    const bruto = JSON.stringify(agendamento("adulterado@exemplo.com"));
    const req = new Request("https://x/webhooks/calcom", {
      method: "POST",
      headers: {
        [HEADER_ASSINATURA]: createHmac("sha256", SEGREDO)
          .update(bruto)
          .digest("hex"),
      },
      body: bruto + " ",
    });
    expect((await tratarWebhookCalcom(req, deps())).status).toBe(401);
  });
});

describe("corpo malformado", () => {
  it("devolve 400 para JSON inválido, nunca 5xx", async () => {
    const bruto = "{isto não é json";
    const req = new Request("https://x/webhooks/calcom", {
      method: "POST",
      headers: {
        [HEADER_ASSINATURA]: createHmac("sha256", SEGREDO)
          .update(bruto)
          .digest("hex"),
      },
      body: bruto,
    });
    expect((await tratarWebhookCalcom(req, deps())).status).toBe(400);
  });

  it("devolve 400 quando falta triggerEvent", async () => {
    const res = await tratarWebhookCalcom(requisicao({ payload: {} }), deps());
    expect(res.status).toBe(400);
  });
});

describe("BOOKING_CREATED", () => {
  it("move o lead para meeting_booked", async () => {
    const lead = await leadNoEstagio("agendou@exemplo.com", "in_conversation");
    const res = await tratarWebhookCalcom(
      requisicao(agendamento("agendou@exemplo.com")),
      deps(),
    );
    expect(res.status).toBe(200);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("meeting_booked");
  });

  it("casa o e-mail ignorando maiúsculas", async () => {
    const lead = await leadNoEstagio("caixa.alta@exemplo.com", "in_conversation");
    await tratarWebhookCalcom(
      requisicao(agendamento("Caixa.Alta@Exemplo.com")),
      deps(),
    );
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("meeting_booked");
  });

  it("aceita agendamento de quem nunca respondeu", async () => {
    const lead = await leadNoEstagio("direto@exemplo.com", "contacted");
    const res = await tratarWebhookCalcom(
      requisicao(agendamento("direto@exemplo.com")),
      deps(),
    );
    expect(res.status).toBe(200);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("meeting_booked");
  });

  it("registra a reunião com uid e horário", async () => {
    await leadNoEstagio("comregistro@exemplo.com", "in_conversation");
    await tratarWebhookCalcom(
      requisicao(agendamento("comregistro@exemplo.com")),
      deps(),
    );

    const { rows } = await banco.db.query<{ payload: Record<string, unknown> }>(
      `select payload from events
       where tenant_id = $1 and kind = 'reuniao_marcada'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.payload.uid).toBe("bkg_abc123");
    expect(rows[0]?.payload.inicio).toBe("2026-09-05T14:00:00.000Z");
  });

  it("responde 200 e registra quando nenhum lead casa — nunca perde a reunião", async () => {
    const res = await tratarWebhookCalcom(
      requisicao(agendamento("ninguem@exemplo.com")),
      deps(),
    );
    expect(res.status).toBe(200);

    const { rows } = await banco.db.query<{ payload: Record<string, unknown> }>(
      `select payload from events
       where tenant_id = $1 and kind = 'agendamento_sem_lead'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.payload.email).toBe("ninguem@exemplo.com");
    expect(rows[0]?.payload.uid).toBe("bkg_abc123");
  });

  it("responde 200 quando o payload não traz participante", async () => {
    const res = await tratarWebhookCalcom(
      requisicao({
        triggerEvent: "BOOKING_CREATED",
        createdAt: "2026-08-31T12:00:00.000Z",
        payload: { uid: "bkg_vazio", attendees: [] },
      }),
      deps(),
    );
    expect(res.status).toBe(200);
  });

  it("é idempotente: reentrega não quebra nem muda o estágio", async () => {
    const lead = await leadNoEstagio("repetido@exemplo.com", "in_conversation");
    const corpo = agendamento("repetido@exemplo.com");

    await tratarWebhookCalcom(requisicao(corpo), deps());
    const res = await tratarWebhookCalcom(requisicao(corpo), deps());

    expect(res.status).toBe(200);
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("meeting_booked");
  });
});

describe("outros eventos", () => {
  it("responde 200 para BOOKING_CANCELLED sem mexer no estágio", async () => {
    const lead = await leadNoEstagio("cancelou@exemplo.com", "in_conversation");
    const res = await tratarWebhookCalcom(
      requisicao({
        ...agendamento("cancelou@exemplo.com"),
        triggerEvent: "BOOKING_CANCELLED",
      }),
      deps(),
    );
    expect(res.status).toBe(200);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("in_conversation");
  });
});
