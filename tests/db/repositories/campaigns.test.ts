import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import {
  criarCampanha,
  buscarCampanha,
  salvarFiltros,
  listarCampanhasAtivas,
} from "../../../src/db/repositories/campaigns.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const base = {
  name: "Indústrias de alimentos",
  nicheDescription: "indústrias de alimentos em SC com 50+ funcionários",
  offerDescription: "Consultoria de dados e BI",
  schedulingLink: "https://cal.com/thiago/30min",
  senderFirstName: "Thiago",
};

describe("criarCampanha", () => {
  it("grava a campanha e devolve a linha criada", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
    });
    expect(campanha.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(campanha.niche_description).toBe(base.nicheDescription);
    expect(campanha.sender_first_name).toBe("Thiago");
    expect(campanha.status).toBe("active");
    expect(campanha.filters).toBeNull();
  });

  it("aplica os padrões de tom e teto diário", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Com padrões",
    });
    expect(campanha.daily_send_limit).toBe(20);
    expect(campanha.tone).toContain("consultivo");
  });

  it("respeita o teto diário informado", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Teto próprio",
      dailySendLimit: 45,
    });
    expect(campanha.daily_send_limit).toBe(45);
  });
});

describe("buscarCampanha", () => {
  it("devolve a campanha pelo id", async () => {
    const criada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Para buscar",
    });
    const achada = await buscarCampanha(banco.db, banco.tenantId, criada.id);
    expect(achada?.name).toBe("Para buscar");
  });

  it("devolve null quando o id não existe", async () => {
    const achada = await buscarCampanha(
      banco.db,
      banco.tenantId,
      "99999999-9999-9999-9999-999999999999",
    );
    expect(achada).toBeNull();
  });

  it("não devolve campanha de outro tenant", async () => {
    const criada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Do tenant certo",
    });
    const outroTenant = "44444444-4444-4444-4444-444444444444";
    await banco.db.query(`insert into tenants (id, name) values ($1, 'Outro')`, [
      outroTenant,
    ]);
    const achada = await buscarCampanha(banco.db, outroTenant, criada.id);
    expect(achada).toBeNull();
  });
});

describe("salvarFiltros", () => {
  it("grava os filtros estruturados e devolve na leitura", async () => {
    const criada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Com filtros",
    });
    const filtros = { cnaes: ["1091101"], ufs: ["SC"], target_roles: ["Gerente de TI"] };
    await salvarFiltros(banco.db, banco.tenantId, criada.id, filtros);

    const relida = await buscarCampanha(banco.db, banco.tenantId, criada.id);
    expect(relida?.filters).toEqual(filtros);
  });
});

describe("listarCampanhasAtivas", () => {
  it("não devolve campanhas pausadas", async () => {
    const pausada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Pausada",
    });
    await banco.db.query(`update campaigns set status = 'paused' where id = $1`, [
      pausada.id,
    ]);
    const ativas = await listarCampanhasAtivas(banco.db, banco.tenantId);
    expect(ativas.map((c) => c.id)).not.toContain(pausada.id);
    expect(ativas.length).toBeGreaterThan(0);
  });
});
