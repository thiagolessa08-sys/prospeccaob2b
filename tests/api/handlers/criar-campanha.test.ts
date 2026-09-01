import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { tratarCriarCampanha } from "../../../src/api/handlers/criar-campanha.js";
import { HEADER_SEGREDO_N8N } from "../../../src/api/handlers/processar-resposta.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const SEGREDO = "segredo-n8n";

const CORPO_VALIDO = {
  name: "Indústrias de climatização SC",
  nicheDescription: "indústrias de climatização em Santa Catarina",
  offerDescription: "Consultoria de dados e BI",
  schedulingLink: "https://cal.com/thiago/30min",
  senderFirstName: "Thiago",
};

function requisicao(corpo: unknown, headers: Record<string, string> = {}) {
  return new Request("http://local/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(corpo),
  });
}

function deps() {
  return { db: banco.db, tenantId: banco.tenantId, segredo: SEGREDO };
}

describe("tratarCriarCampanha", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await tratarCriarCampanha(requisicao(CORPO_VALIDO), deps());
    expect(res.status).toBe(401);
  });

  it("recusa corpo que não é JSON válido", async () => {
    const req = new Request("http://local/campaigns", {
      method: "POST",
      headers: { [HEADER_SEGREDO_N8N]: SEGREDO },
      body: "isto não é json",
    });
    const res = await tratarCriarCampanha(req, deps());
    expect(res.status).toBe(400);
  });

  it("recusa quando falta campo obrigatório", async () => {
    const { nicheDescription, ...semNicho } = CORPO_VALIDO;
    const res = await tratarCriarCampanha(
      requisicao(semNicho, { [HEADER_SEGREDO_N8N]: SEGREDO }),
      deps(),
    );
    expect(res.status).toBe(400);
    const corpo = (await res.json()) as { erro: string };
    expect(corpo.erro).toContain("nicheDescription");
  });

  it("recusa campo obrigatório vazio, não só ausente", async () => {
    const res = await tratarCriarCampanha(
      requisicao(
        { ...CORPO_VALIDO, name: "   " },
        { [HEADER_SEGREDO_N8N]: SEGREDO },
      ),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("cria a campanha e devolve 201 com os dados salvos", async () => {
    const res = await tratarCriarCampanha(
      requisicao(CORPO_VALIDO, { [HEADER_SEGREDO_N8N]: SEGREDO }),
      deps(),
    );
    expect(res.status).toBe(201);

    const corpo = (await res.json()) as { id: string; name: string; filters: unknown };
    expect(corpo.name).toBe(CORPO_VALIDO.name);
    expect(corpo.filters).toBeNull();

    const { rows } = await banco.db.query<{ tenant_id: string }>(
      `select tenant_id from campaigns where id = $1`,
      [corpo.id],
    );
    expect(rows[0]?.tenant_id).toBe(banco.tenantId);
  });
});
