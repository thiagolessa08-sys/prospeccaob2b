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
    senhaDoPainel: "senha-do-painel",
    apiKeyHunter: "chave-hunter",
    apiKeyLusha: "",
    apiKeyCasaDosDados: "chave-casa-dos-dados",
  });
}

describe("rotas", () => {
  it("responde na raiz, para a URL do serviço não parecer quebrada", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      servico: "prospeccao-b2b",
      ok: true,
      saude: "/saude",
    });
  });

  it("responde ao health check", async () => {
    const res = await app().request("/saude");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("roteia a listagem de campanhas ativas", async () => {
    const res = await app().request("/campaigns/ativas", {
      headers: { "x-prospeccao-segredo": "segredo-n8n" },
    });
    expect(res.status).toBe(200);
    // `subirBanco` já cria uma campanha de teste, ativa por padrão.
    const corpo = (await res.json()) as Array<{ id: string }>;
    expect(corpo.map((c) => c.id)).toContain(banco.campaignId);
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

describe("erros não tratados", () => {
  it("loga a causa real e devolve 500 genérico ao cliente", async () => {
    // Um banco que estoura em qualquer consulta reproduz o que aconteceu em
    // produção: rota autenticada, query falha, cliente recebe 500 mudo.
    const bancoQuebrado = {
      query: async () => {
        throw new Error('relation "campaigns" does not exist');
      },
    };
    const erros: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => erros.push(String(msg));

    try {
      const appQuebrado = criarApp({
        db: bancoQuebrado as never,
        tenantId: banco.tenantId,
        segredoInstantly: SEGREDO_INSTANTLY,
        segredoCalcom: SEGREDO_CALCOM,
        segredoN8n: "segredo-n8n",
        senhaDoPainel: "senha-do-painel",
        apiKeyHunter: "chave-hunter",
        apiKeyLusha: "",
        apiKeyCasaDosDados: "chave-casa-dos-dados",
      });
      const res = await appQuebrado.request("/campaigns/ativas", {
        headers: { "x-prospeccao-segredo": "segredo-n8n" },
      });

      expect(res.status).toBe(500);
      // O cliente não recebe detalhe interno...
      expect(await res.json()).toEqual({ erro: "erro interno" });
      // ...mas o log do servidor recebe, senão não há como depurar.
      expect(erros.join("\n")).toContain('relation "campaigns" does not exist');
      expect(erros.join("\n")).toContain("/campaigns/ativas");
    } finally {
      console.error = original;
    }
  });
});
