import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  subirBanco,
  criarTenantVizinho,
  type BancoDeTeste,
} from "../../helpers/pg.js";
import { criarCampanha } from "../../../src/db/repositories/campaigns.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import { criarLead } from "../../../src/db/repositories/leads.js";
import { anexarMensagem } from "../../../src/db/repositories/messages.js";
import { registrarEvento } from "../../../src/db/repositories/events.js";
import {
  tratarResumoDoPainel,
  tratarLeadsDaCampanha,
  tratarDetalheDoLead,
  tratarEmpresasDaCampanha,
} from "../../../src/api/handlers/painel.js";
import { HEADER_SEGREDO_N8N } from "../../../src/api/handlers/processar-resposta.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const SEGREDO = "segredo-n8n";

function requisicao(url: string, headers: Record<string, string> = {}) {
  return new Request("http://local" + url, { headers });
}

function comSegredo(url: string) {
  return requisicao(url, { [HEADER_SEGREDO_N8N]: SEGREDO });
}

function deps() {
  return {
    db: banco.db,
    tenantId: banco.tenantId,
    segredo: SEGREDO,
    provedorDeEnriquecimento: "hunter",
  };
}

/** Cria campanha com uma empresa e um lead, e devolve os três ids. */
async function cenario(nome: string, cnpj: string, email: string) {
  const campanha = await criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    name: nome,
    nicheDescription: "indústrias",
    offerDescription: "BI",
    schedulingLink: "https://cal.com/t/30min",
    senderFirstName: "Thiago",
  });

  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      cnpj,
      legalName: "ALFA LTDA",
      tradeName: "Alfa",
      website: null,
      city: null,
      uf: null,
      employeeCount: null,
      summary: null,
      source: "casa_dos_dados",
    },
  ]);

  const { rows } = await banco.db.query<{ id: string }>(
    `select id from companies where tenant_id = $1 and cnpj = $2`,
    [banco.tenantId, cnpj],
  );
  const companyId = rows[0]!.id;

  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: campanha.id,
    companyId,
    email,
    fullName: "Maria Souza",
    roleTitle: "Administradora",
    emailVerified: true,
  });

  return { campanha, companyId, lead };
}

describe("tratarResumoDoPainel", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await tratarResumoDoPainel(requisicao("/painel/campanhas"), deps());
    expect(res.status).toBe(401);
  });

  it("conta empresas e leads da campanha", async () => {
    const { campanha } = await cenario("Resumo", "20000000000101", "resumo@alfa.com.br");

    const res = await tratarResumoDoPainel(comSegredo("/painel/campanhas"), deps());
    expect(res.status).toBe(200);

    const corpo = (await res.json()) as Array<{
      id: string;
      empresas: { pending: number; enriched: number; failed: number };
      leads: Record<string, number>;
    }>;
    const minha = corpo.find((c) => c.id === campanha.id);

    expect(minha?.empresas.pending).toBe(1);
    expect(minha?.leads.discovered).toBe(1);
  });

  it("preenche com zero o estágio sem nenhum lead, em vez de omitir a chave", async () => {
    // Um estágio ausente viraria `undefined` na tela, que o operador lê como
    // "não sei" — e não como "nenhum", que é o que o banco está dizendo.
    const { campanha } = await cenario("Zeros", "21000000000101", "zeros@alfa.com.br");

    const res = await tratarResumoDoPainel(comSegredo("/painel/campanhas"), deps());
    const corpo = (await res.json()) as Array<{ id: string; leads: Record<string, number> }>;
    const minha = corpo.find((c) => c.id === campanha.id);

    expect(minha?.leads.meeting_booked).toBe(0);
    expect(minha?.leads.error).toBe(0);
    expect(minha?.leads.in_conversation).toBe(0);
  });

  it("inclui campanha pausada, que a rota do n8n esconde", async () => {
    const pausada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      name: "Pausada no painel",
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    });
    await banco.db.query(`update campaigns set status = 'paused' where id = $1`, [
      pausada.id,
    ]);

    const res = await tratarResumoDoPainel(comSegredo("/painel/campanhas"), deps());
    const corpo = (await res.json()) as Array<{ id: string }>;

    expect(corpo.map((c) => c.id)).toContain(pausada.id);
  });

  it("não conta empresa nem lead de outro tenant", async () => {
    const vizinho = await criarTenantVizinho(banco.db, "0b01");

    const res = await tratarResumoDoPainel(comSegredo("/painel/campanhas"), deps());
    const corpo = (await res.json()) as Array<{ id: string }>;

    expect(corpo.map((c) => c.id)).not.toContain(vizinho.campaignId);
  });
});

describe("tratarLeadsDaCampanha", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await tratarLeadsDaCampanha(
      requisicao("/painel/campanhas/x/leads"),
      banco.campaignId,
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("recusa id que não é uuid, com 400 em vez de estourar no driver", async () => {
    const res = await tratarLeadsDaCampanha(
      comSegredo("/painel/campanhas/nao-e-uuid/leads"),
      "nao-e-uuid",
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("devolve o lead com o nome da empresa junto", async () => {
    const { campanha, lead } = await cenario(
      "Com empresa",
      "22000000000101",
      "comempresa@alfa.com.br",
    );

    const res = await tratarLeadsDaCampanha(
      comSegredo("/painel/campanhas/" + campanha.id + "/leads"),
      campanha.id,
      deps(),
    );
    expect(res.status).toBe(200);

    const corpo = (await res.json()) as Array<{ id: string; empresa: string; email: string }>;
    expect(corpo).toHaveLength(1);
    expect(corpo[0]?.id).toBe(lead.id);
    expect(corpo[0]?.empresa).toBe("Alfa");
  });

  it("respeita o limite pedido na query", async () => {
    const { campanha, companyId } = await cenario(
      "Limite",
      "23000000000101",
      "limite1@alfa.com.br",
    );
    await criarLead(banco.db, {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      companyId,
      email: "limite2@alfa.com.br",
      fullName: null,
      roleTitle: null,
      emailVerified: false,
    });

    const res = await tratarLeadsDaCampanha(
      comSegredo("/painel/campanhas/" + campanha.id + "/leads?limite=1"),
      campanha.id,
      deps(),
    );
    const corpo = (await res.json()) as unknown[];
    expect(corpo).toHaveLength(1);
  });
});

describe("tratarDetalheDoLead", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await tratarDetalheDoLead(
      requisicao("/painel/leads/x"),
      "x",
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("devolve 404 para lead que não existe", async () => {
    const res = await tratarDetalheDoLead(
      comSegredo("/painel/leads/99999999-9999-9999-9999-999999999999"),
      "99999999-9999-9999-9999-999999999999",
      deps(),
    );
    expect(res.status).toBe(404);
  });

  it("junta lead, conversa e eventos", async () => {
    const { lead } = await cenario("Detalhe", "24000000000101", "detalhe@alfa.com.br");

    await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      direction: "outbound",
      subject: "Olá",
      body: "Primeira abordagem.",
    });
    await registrarEvento(banco.db, {
      tenantId: banco.tenantId,
      leadId: lead.id,
      kind: "tentativa_de_enriquecimento",
      payload: { achou: true },
    });

    const res = await tratarDetalheDoLead(
      comSegredo("/painel/leads/" + lead.id),
      lead.id,
      deps(),
    );
    expect(res.status).toBe(200);

    const corpo = (await res.json()) as {
      lead: { id: string; email: string };
      conversa: Array<{ body: string }>;
      eventos: Array<{ kind: string }>;
    };
    expect(corpo.lead.id).toBe(lead.id);
    expect(corpo.conversa[0]?.body).toBe("Primeira abordagem.");
    expect(corpo.eventos[0]?.kind).toBe("tentativa_de_enriquecimento");
  });

  it("não devolve lead de outro tenant", async () => {
    const vizinho = await criarTenantVizinho(banco.db, "0b02");

    const res = await tratarDetalheDoLead(
      comSegredo("/painel/leads/" + vizinho.leadId),
      vizinho.leadId,
      deps(),
    );
    expect(res.status).toBe(404);
  });
});

describe("tratarEmpresasDaCampanha", () => {
  it("recusa sem o segredo certo", async () => {
    const res = await tratarEmpresasDaCampanha(
      requisicao("/painel/campanhas/x/empresas"),
      banco.campaignId,
      deps(),
    );
    expect(res.status).toBe(401);
  });

  it("lista as empresas descobertas da campanha", async () => {
    const { campanha } = await cenario(
      "Empresas",
      "25000000000101",
      "empresas@alfa.com.br",
    );

    const res = await tratarEmpresasDaCampanha(
      comSegredo("/painel/campanhas/" + campanha.id + "/empresas"),
      campanha.id,
      deps(),
    );
    expect(res.status).toBe(200);

    const corpo = (await res.json()) as Array<{
      cnpj: string;
      enrichment_status: string;
      ultima_tentativa: unknown;
    }>;
    expect(corpo).toHaveLength(1);
    expect(corpo[0]?.cnpj).toBe("25000000000101");
    expect(corpo[0]?.enrichment_status).toBe("pending");
    // Nunca tentada ainda: a tela mostra "ainda não tentada" a partir disto.
    expect(corpo[0]?.ultima_tentativa).toBeNull();
  });

  it("traz o motivo da última tentativa junto da empresa", async () => {
    // É a resposta para "por que esta empresa ficou sem decisor?". Sem o join
    // lateral, o motivo existe em `events` e não aparece em tela nenhuma:
    // `Ver leads` só mostra quem virou lead, ou seja, quem deu certo.
    const { campanha, companyId } = await cenario(
      "Com motivo",
      "26000000000101",
      "commotivo@alfa.com.br",
    );

    await registrarEvento(banco.db, {
      tenantId: banco.tenantId,
      leadId: null,
      kind: "tentativa_de_enriquecimento",
      payload: {
        companyId,
        achou: false,
        provedor: "hunter",
        motivo: "Sem domínio para procurar o e-mail do decisor.",
      },
    });

    const res = await tratarEmpresasDaCampanha(
      comSegredo("/painel/campanhas/" + campanha.id + "/empresas"),
      campanha.id,
      deps(),
    );
    const corpo = (await res.json()) as Array<{
      ultima_tentativa: { motivo: string; provedor: string } | null;
    }>;

    expect(corpo[0]?.ultima_tentativa?.motivo).toContain("Sem domínio");
    expect(corpo[0]?.ultima_tentativa?.provedor).toBe("hunter");
  });

  it("não devolve empresa de outro tenant", async () => {
    const vizinho = await criarTenantVizinho(banco.db, "0b03");

    const res = await tratarEmpresasDaCampanha(
      comSegredo("/painel/campanhas/" + vizinho.campaignId + "/empresas"),
      vizinho.campaignId,
      deps(),
    );
    // A campanha existe, mas é de outro dono: a consulta filtra por tenant.
    expect(await res.json()).toEqual([]);
  });
});

describe("campos que o tipo promete e a consulta precisa trazer", () => {
  it("devolve external_id da empresa vinda de fornecedor", async () => {
    /**
     * Guarda para uma classe de erro que já apareceu duas vezes: a coluna
     * existe na migration, o tipo declara o campo, e a consulta não o
     * seleciona. O valor chega `undefined` sem erro nenhum, e o código que
     * depende dele simplesmente não funciona — foi o que fez a busca de
     * contato por id da empresa não sair do lugar.
     */
    const { salvarEmpresasExternas } = await import(
      "../../../src/db/repositories/companies.js"
    );
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      name: "Com external_id",
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    });

    await salvarEmpresasExternas(banco.db, [
      {
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        externalId: "v1.company.teste",
        legalName: "Alfa Alimentos",
        website: "alfa.com.br",
        city: "Joinville",
        uf: "SC",
        employeeCount: 450,
        summary: "Food & Beverage",
        source: "lusha",
      },
    ]);

    const res = await tratarEmpresasDaCampanha(
      comSegredo("/painel/campanhas/" + campanha.id + "/empresas"),
      campanha.id,
      deps(),
    );
    const corpo = (await res.json()) as Array<{
      external_id: string | null;
      website: string | null;
      cnpj: string | null;
    }>;

    expect(corpo[0]?.external_id).toBe("v1.company.teste");
    // O domínio é o que faz a busca de contato funcionar; sem CNPJ, é o que
    // resta junto do id.
    expect(corpo[0]?.website).toBe("alfa.com.br");
    expect(corpo[0]?.cnpj).toBeNull();
  });

  it("a fila de enriquecimento também traz o external_id", async () => {
    // É de `listarPendentesDeEnriquecimento` que o lote lê o id para mandar à
    // Lusha. Se a consulta não trouxer, a busca por id nunca acontece.
    const { salvarEmpresasExternas, listarPendentesDeEnriquecimento } = await import(
      "../../../src/db/repositories/companies.js"
    );
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      name: "Fila com external_id",
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    });

    await salvarEmpresasExternas(banco.db, [
      {
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        externalId: "v1.company.fila",
        legalName: "Beta",
        website: "beta.com.br",
        city: null,
        uf: null,
        employeeCount: null,
        summary: null,
        source: "lusha",
      },
    ]);

    const pendentes = await listarPendentesDeEnriquecimento(
      banco.db,
      banco.tenantId,
      campanha.id,
      10,
    );
    expect(pendentes[0]?.external_id).toBe("v1.company.fila");
  });
});

describe("duas campanhas podem mirar a mesma empresa", () => {
  it("a segunda campanha salva a empresa que a primeira já tem", async () => {
    /**
     * O defeito que isto fecha: os índices de deduplicação eram por tenant, e
     * não por campanha. A segunda campanha descobria as mesmas empresas,
     * todas colidiam, nada era salvo — e a tela dizia "0 nova(s) salva(s)"
     * sem que nada tivesse dado errado.
     *
     * `companies` é a lista de alvos DAQUELA campanha, não o cadastro de
     * empresas do tenant. O que impede contatar a mesma pessoa duas vezes é a
     * lista de supressão, na última milha do envio.
     */
    const { salvarEmpresasExternas } = await import(
      "../../../src/db/repositories/companies.js"
    );

    const base = {
      tenantId: banco.tenantId,
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    };
    const primeira = await criarCampanha(banco.db, { ...base, name: "Primeira" });
    const segunda = await criarCampanha(banco.db, { ...base, name: "Segunda" });

    const empresa = (campaignId: string) => ({
      tenantId: banco.tenantId,
      campaignId,
      externalId: "v1.company.compartilhada",
      legalName: "Alfa Alimentos",
      website: "alfa.com.br",
      city: null,
      uf: null,
      employeeCount: null,
      summary: null,
      source: "lusha",
    });

    const na1 = await salvarEmpresasExternas(banco.db, [empresa(primeira.id)]);
    const na2 = await salvarEmpresasExternas(banco.db, [empresa(segunda.id)]);

    expect(na1.inseridas).toBe(1);
    expect(na2.inseridas).toBe(1);
  });

  it("mas a mesma empresa duas vezes na MESMA campanha continua sendo uma", async () => {
    // A deduplicação não sumiu: mudou de escopo. Rodar a descoberta duas
    // vezes na mesma campanha não pode duplicar alvo.
    const { salvarEmpresasExternas } = await import(
      "../../../src/db/repositories/companies.js"
    );
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      name: "Dedup na mesma",
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    });

    const empresa = {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      externalId: "v1.company.repetida",
      legalName: "Beta",
      website: null,
      city: null,
      uf: null,
      employeeCount: null,
      summary: null,
      source: "lusha",
    };

    const primeira = await salvarEmpresasExternas(banco.db, [empresa]);
    const segunda = await salvarEmpresasExternas(banco.db, [empresa]);

    expect(primeira.inseridas).toBe(1);
    expect(segunda.inseridas).toBe(0);
    expect(segunda.ignoradas).toBe(1);
  });
});

describe("tratarVerificarEmailDoLead", () => {
  it("destrava o lead e registra quem decidiu", async () => {
    // Sobrepõe a trava que protege a reputação do domínio. Se o bounce vier
    // depois, o evento é o que explica por que aquele endereço saiu.
    const { tratarVerificarEmailDoLead } = await import(
      "../../../src/api/handlers/painel.js"
    );
    const { lead } = await cenario("Destravar", "27000000000101", "travado@alfa.com.br");

    await banco.db.query(`update leads set email_verified = false where id = $1`, [
      lead.id,
    ]);

    const res = await tratarVerificarEmailDoLead(
      comSegredo("/painel/leads/" + lead.id + "/verificar-email"),
      lead.id,
      deps(),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { mudou: boolean }).toMatchObject({ mudou: true });

    const { rows } = await banco.db.query<{ email_verified: boolean }>(
      `select email_verified from leads where id = $1`,
      [lead.id],
    );
    expect(rows[0]?.email_verified).toBe(true);

    const { rows: eventos } = await banco.db.query<{ kind: string }>(
      `select kind from events where lead_id = $1 and kind = 'email_verificado_manualmente'`,
      [lead.id],
    );
    expect(eventos).toHaveLength(1);
  });

  it("não registra evento quando já estava verificado", async () => {
    // `mudou: false` distingue "destravei" de "já estava assim" sem uma
    // segunda consulta — e sem poluir a trilha com decisão que não houve.
    const { tratarVerificarEmailDoLead } = await import(
      "../../../src/api/handlers/painel.js"
    );
    const { lead } = await cenario("Já verificado", "28000000000101", "ok@alfa.com.br");

    const res = await tratarVerificarEmailDoLead(
      comSegredo("/painel/leads/" + lead.id + "/verificar-email"),
      lead.id,
      deps(),
    );
    expect((await res.json()) as { mudou: boolean }).toMatchObject({ mudou: false });
  });

  it("recusa sem o segredo certo", async () => {
    const { tratarVerificarEmailDoLead } = await import(
      "../../../src/api/handlers/painel.js"
    );
    const res = await tratarVerificarEmailDoLead(
      requisicao("/painel/leads/x/verificar-email"),
      "99999999-9999-9999-9999-999999999999",
      deps(),
    );
    expect(res.status).toBe(401);
  });
});
