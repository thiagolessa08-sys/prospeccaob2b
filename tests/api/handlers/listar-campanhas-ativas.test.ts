import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { criarCampanha } from "../../../src/db/repositories/campaigns.js";
import { tratarListarCampanhasAtivas } from "../../../src/api/handlers/listar-campanhas-ativas.js";
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
  return new Request("http://local/campaigns/ativas", { headers });
}

describe("tratarListarCampanhasAtivas", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await tratarListarCampanhasAtivas(requisicao(), {
      db: banco.db,
      tenantId: banco.tenantId,
      segredo: SEGREDO,
    });
    expect(res.status).toBe(401);
  });

  it("lista só as campanhas ativas do tenant", async () => {
    const ativa = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      name: "Ativa para listar",
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    });
    const pausada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      name: "Pausada para listar",
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    });
    await banco.db.query(`update campaigns set status = 'paused' where id = $1`, [
      pausada.id,
    ]);

    const res = await tratarListarCampanhasAtivas(
      requisicao({ [HEADER_SEGREDO_N8N]: SEGREDO }),
      { db: banco.db, tenantId: banco.tenantId, segredo: SEGREDO },
    );
    expect(res.status).toBe(200);

    const corpo = (await res.json()) as Array<{ id: string; name: string }>;
    const ids = corpo.map((c) => c.id);
    expect(ids).toContain(ativa.id);
    expect(ids).not.toContain(pausada.id);
  });
});
