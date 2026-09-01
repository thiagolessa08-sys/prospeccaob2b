import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { tratarGerarFiltros } from "../../../src/api/handlers/gerar-filtros.js";
import { HEADER_SEGREDO_N8N } from "../../../src/api/handlers/processar-resposta.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const SEGREDO = "segredo-n8n";

function requisicao(headers: Record<string, string> = {}) {
  return new Request("http://local/campaigns/x/gerar-filtros", {
    method: "POST",
    headers,
  });
}

describe("tratarGerarFiltros", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await tratarGerarFiltros(requisicao(), "qualquer-id", {
      db: banco.db,
      tenantId: banco.tenantId,
      segredo: SEGREDO,
    });
    expect(res.status).toBe(401);
  });

  it("devolve 404 para campanha inexistente, sem chamar a IA", async () => {
    const res = await tratarGerarFiltros(
      requisicao({ [HEADER_SEGREDO_N8N]: SEGREDO }),
      "99999999-9999-9999-9999-999999999999",
      { db: banco.db, tenantId: banco.tenantId, segredo: SEGREDO },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      gerado: false,
      motivo: "Campanha não encontrada.",
    });
  });
});
