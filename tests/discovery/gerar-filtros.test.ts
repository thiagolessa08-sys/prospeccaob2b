import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { criarCampanha, buscarCampanha } from "../../src/db/repositories/campaigns.js";
import { gerarFiltros } from "../../src/discovery/gerar-filtros.js";
import type { NicheFilters } from "../../src/ai/niche-parser.js";

let banco: BancoDeTeste;
let contador = 0;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const FILTROS: NicheFilters = {
  cnaes: ["4322301"],
  ufs: ["SC"],
  cities: [],
  min_employees: null,
  max_employees: null,
  target_roles: ["Gerente de TI"],
  keywords: [],
};

async function campanha(nicheDescription = "indústrias de climatização em SC") {
  contador += 1;
  return criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    name: `Gerar filtros ${contador}`,
    nicheDescription,
    offerDescription: "BI",
    schedulingLink: "https://cal.com/t/30min",
    senderFirstName: "Thiago",
  });
}

describe("gerarFiltros — casos de entrada", () => {
  it("recusa campanha inexistente", async () => {
    const resultado = await gerarFiltros(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: "99999999-9999-9999-9999-999999999999",
      },
      { parseNiche: vi.fn() },
    );
    expect(resultado).toEqual({
      gerado: false,
      motivo: "Campanha não encontrada.",
    });
  });
});

describe("gerarFiltros — caminho feliz", () => {
  it("chama a IA com a descrição da campanha e salva o resultado", async () => {
    const c = await campanha("indústrias de climatização em SC");
    const parseNiche = vi.fn().mockResolvedValue(FILTROS);

    const resultado = await gerarFiltros(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { parseNiche },
    );

    expect(resultado).toEqual({ gerado: true, filtros: FILTROS });
    expect(parseNiche).toHaveBeenCalledWith("indústrias de climatização em SC");

    const relida = await buscarCampanha(banco.db, banco.tenantId, c.id);
    expect(relida?.filters).toEqual(FILTROS);
  });
});

describe("gerarFiltros — falha da IA", () => {
  it("não salva filtro nenhum e registra o evento", async () => {
    const c = await campanha();
    const parseNiche = vi.fn().mockRejectedValue(new Error("Claude fora do ar"));

    const resultado = await gerarFiltros(
      { db: banco.db, tenantId: banco.tenantId, campaignId: c.id },
      { parseNiche },
    );

    expect(resultado.gerado).toBe(false);
    if (!resultado.gerado) {
      expect(resultado.motivo).toContain("Claude fora do ar");
    }

    const relida = await buscarCampanha(banco.db, banco.tenantId, c.id);
    expect(relida?.filters).toBeNull();

    const { rows } = await banco.db.query<{ payload: { erro: string } }>(
      `select payload from events where tenant_id = $1 and kind = 'falha_ao_gerar_filtros'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.payload.erro).toContain("Claude fora do ar");
  });
});
