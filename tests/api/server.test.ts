import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { criarApp } from "../../src/api/server.js";
import { HEADER_SEGREDO } from "../../src/api/handlers/instantly-webhook.js";
import { HEADER_ASSINATURA } from "../../src/api/handlers/calcom-webhook.js";

const SEGREDO_INSTANTLY = "segredo-instantly";
const SEGREDO_CALCOM = "segredo-calcom";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

function app() {
  return criarApp({
    db: banco.db,
    tenantId: banco.tenantId,
    segredoInstantly: SEGREDO_INSTANTLY,
    segredoCalcom: SEGREDO_CALCOM,
    segredoN8n: "segredo-n8n",
    apiKeyHunter: "chave-hunter",
  });
}

describe("rotas", () => {
  it("responde ao health check", async () => {
    const res = await app().request("/saude");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("roteia o webhook do Instantly", async () => {
    const res = await app().request("/webhooks/instantly", {
      method: "POST",
      headers: { [HEADER_SEGREDO]: SEGREDO_INSTANTLY },
      body: JSON.stringify({
        event_type: "algo_desconhecido",
        lead_email: "x@exemplo.com",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("roteia o webhook do Cal.com", async () => {
    const corpo = JSON.stringify({
      triggerEvent: "BOOKING_CANCELLED",
      payload: {},
    });
    const res = await app().request("/webhooks/calcom", {
      method: "POST",
      headers: {
        [HEADER_ASSINATURA]: createHmac("sha256", SEGREDO_CALCOM)
          .update(corpo)
          .digest("hex"),
      },
      body: corpo,
    });
    expect(res.status).toBe(200);
  });

  it("usa o segredo certo em cada rota, sem confundi-los", async () => {
    const res = await app().request("/webhooks/instantly", {
      method: "POST",
      headers: { [HEADER_SEGREDO]: SEGREDO_CALCOM },
      body: JSON.stringify({ event_type: "x", lead_email: "a@b.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("devolve 404 para rota desconhecida", async () => {
    expect((await app().request("/nao-existe")).status).toBe(404);
  });

  it("devolve 404 para GET numa rota que só aceita POST", async () => {
    expect((await app().request("/webhooks/instantly")).status).toBe(404);
  });
});
