import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import {
  criarCampanha,
  buscarCampanha,
  salvarFiltros,
  listarCampanhasAtivas,
  contarEnviosEBounces,
  contarEnviosDeHoje,
  pausarCampanha,
  definirModoDeEnvio,
} from "../../../src/db/repositories/campaigns.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import { criarLead } from "../../../src/db/repositories/leads.js";
import { anexarMensagem } from "../../../src/db/repositories/messages.js";

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

describe("contarEnviosEBounces", () => {
  it("conta só o que saiu de verdade, ignorando sombra e recebidas", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Para contar",
    });
    await salvarEmpresas(banco.db, [
      {
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        cnpj: "91111111000101",
        legalName: "Empresa da contagem",
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
      `select id from companies where cnpj = '91111111000101'`,
    );
    const lead = await criarLead(banco.db, {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      companyId: rows[0]!.id,
      fullName: "Contagem",
      roleTitle: null,
      email: "contagem@exemplo.com",
      emailVerified: true,
    });

    await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "outbound",
      body: "enviada de verdade",
    });
    await banco.db.query(
      `insert into messages (tenant_id, lead_id, direction, body, shadow)
       values ($1, $2, 'outbound', 'só sombra', true)`,
      [banco.tenantId, lead.id],
    );
    await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "inbound",
      body: "resposta do lead",
    });

    const contagem = await contarEnviosEBounces(
      banco.db,
      banco.tenantId,
      campanha.id,
    );
    expect(contagem.enviados).toBe(1);
    expect(contagem.bounces).toBe(0);
  });

  it("conta leads marcados com bounce", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Com bounce",
    });
    await salvarEmpresas(banco.db, [
      {
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        cnpj: "92222222000101",
        legalName: "Empresa do bounce",
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
      `select id from companies where cnpj = '92222222000101'`,
    );
    const lead = await criarLead(banco.db, {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      companyId: rows[0]!.id,
      fullName: null,
      roleTitle: null,
      email: "quebrou@exemplo.com",
      emailVerified: true,
    });
    await banco.db.query(`update leads set bounced_at = now() where id = $1`, [
      lead.id,
    ]);

    const contagem = await contarEnviosEBounces(
      banco.db,
      banco.tenantId,
      campanha.id,
    );
    expect(contagem.bounces).toBe(1);
  });

  it("devolve números, não strings vindas do driver", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Tipos da contagem",
    });
    const contagem = await contarEnviosEBounces(
      banco.db,
      banco.tenantId,
      campanha.id,
    );
    expect(typeof contagem.enviados).toBe("number");
    expect(typeof contagem.bounces).toBe("number");
  });

  it("não conta o que é de outra campanha", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Isolada",
    });
    const contagem = await contarEnviosEBounces(
      banco.db,
      banco.tenantId,
      campanha.id,
    );
    expect(contagem.enviados).toBe(0);
  });
});

describe("contarEnviosDeHoje", () => {
  /** Campanha nova com um lead pronto, para escrever mensagens em cima. */
  async function comLead(nome: string, cnpj: string) {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: nome,
    });
    await salvarEmpresas(banco.db, [
      {
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        cnpj,
        legalName: `Empresa ${nome}`,
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
      `select id from companies where cnpj = $1`,
      [cnpj],
    );
    const lead = await criarLead(banco.db, {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      companyId: rows[0]!.id,
      fullName: null,
      roleTitle: null,
      email: `${cnpj}@exemplo.com.br`,
      emailVerified: true,
    });
    return { campanha, lead };
  }

  it("conta as mensagens de saída reais do dia", async () => {
    const { campanha, lead } = await comLead("Hoje", "96111111000101");
    await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "outbound",
      body: "saiu hoje",
    });

    expect(
      await contarEnviosDeHoje(banco.db, banco.tenantId, campanha.id),
    ).toBe(1);
  });

  it("não conta ensaio em sombra — nada saiu", async () => {
    const { campanha, lead } = await comLead("Sombra", "96222222000101");
    await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "outbound",
      body: "ensaio",
      shadow: true,
    });

    expect(
      await contarEnviosDeHoje(banco.db, banco.tenantId, campanha.id),
    ).toBe(0);
  });

  it("não conta mensagem de entrada", async () => {
    const { campanha, lead } = await comLead("Entrada", "96333333000101");
    await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "inbound",
      body: "resposta",
    });

    expect(
      await contarEnviosDeHoje(banco.db, banco.tenantId, campanha.id),
    ).toBe(0);
  });

  it("não conta o que saiu ontem", async () => {
    const { campanha, lead } = await comLead("Ontem", "96444444000101");
    const mensagem = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "outbound",
      body: "saiu ontem",
    });
    await banco.db.query(
      `update messages set created_at = now() - interval '1 day' where id = $1`,
      [mensagem!.id],
    );

    expect(
      await contarEnviosDeHoje(banco.db, banco.tenantId, campanha.id),
    ).toBe(0);
  });

  it("devolve número, não string vinda do driver", async () => {
    const { campanha } = await comLead("Tipo", "96555555000101");
    expect(
      typeof (await contarEnviosDeHoje(banco.db, banco.tenantId, campanha.id)),
    ).toBe("number");
  });
});

describe("pausarCampanha", () => {
  it("muda o status e some da lista de ativas", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Para pausar",
    });
    await pausarCampanha(
      banco.db,
      banco.tenantId,
      campanha.id,
      "bounce acima do limite",
    );

    const relida = await buscarCampanha(banco.db, banco.tenantId, campanha.id);
    expect(relida?.status).toBe("paused");

    const ativas = await listarCampanhasAtivas(banco.db, banco.tenantId);
    expect(ativas.map((c) => c.id)).not.toContain(campanha.id);
  });

  it("é idempotente: pausar duas vezes não quebra", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Pausada duas vezes",
    });
    await pausarCampanha(banco.db, banco.tenantId, campanha.id, "primeira");
    await expect(
      pausarCampanha(banco.db, banco.tenantId, campanha.id, "segunda"),
    ).resolves.toBeUndefined();
  });

  it("registra o evento uma vez só, mesmo pausando duas vezes", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Evento único",
    });
    await pausarCampanha(banco.db, banco.tenantId, campanha.id, "primeira");
    await pausarCampanha(banco.db, banco.tenantId, campanha.id, "segunda");

    const { rows } = await banco.db.query<{ total: number }>(
      `select count(*)::int as total from events
       where tenant_id = $1 and kind = 'campanha_pausada'
         and payload->>'campaignId' = $2`,
      [banco.tenantId, campanha.id],
    );
    expect(rows[0]!.total).toBe(1);
  });
});

describe("definirModoDeEnvio", () => {
  it("promove a campanha de sombra para produção", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Promovida",
    });
    expect(campanha.send_mode).toBe("shadow");

    await definirModoDeEnvio(banco.db, banco.tenantId, campanha.id, "live");
    const relida = await buscarCampanha(banco.db, banco.tenantId, campanha.id);
    expect(relida?.send_mode).toBe("live");
  });
});
