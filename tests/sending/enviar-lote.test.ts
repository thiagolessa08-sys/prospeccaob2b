import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { criarCampanha, definirModoDeEnvio, buscarCampanha } from "../../src/db/repositories/campaigns.js";
import { salvarEmpresas } from "../../src/db/repositories/companies.js";
import { criarLead, buscarLead } from "../../src/db/repositories/leads.js";
import { adicionarSupressao } from "../../src/db/repositories/suppression.js";
import { enviarLote } from "../../src/sending/enviar-lote.js";
import type { ColdEmailProvider } from "../../src/sending/types.js";

let banco: BancoDeTeste;
let contador = 0;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const base = {
  name: "Lote",
  nicheDescription: "indústrias",
  offerDescription: "BI",
  schedulingLink: "https://cal.com/t/30min",
  senderFirstName: "Thiago",
};

/** Cria uma campanha em modo `live` com N leads prontos para contato. */
async function cenario(quantosLeads: number, dailySendLimit = 20) {
  contador += 1;
  const campanha = await criarCampanha(banco.db, {
    tenantId: banco.tenantId,
    ...base,
    name: `Lote ${contador}`,
    dailySendLimit,
  });
  await definirModoDeEnvio(banco.db, banco.tenantId, campanha.id, "live");

  const cnpj = `9500000${String(contador).padStart(2, "0")}000101`;
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      cnpj,
      legalName: `Empresa ${contador}`,
      tradeName: null,
      website: "https://exemplo.com.br",
      city: null,
      uf: null,
      employeeCount: null,
      summary: "Faz coisas.",
      source: "cnpj",
    },
  ]);
  const { rows } = await banco.db.query<{ id: string }>(
    `select id from companies where cnpj = $1`,
    [cnpj],
  );

  const leads = [];
  for (let i = 0; i < quantosLeads; i++) {
    leads.push(
      await criarLead(banco.db, {
        tenantId: banco.tenantId,
        campaignId: campanha.id,
        companyId: rows[0]!.id,
        fullName: `Pessoa ${contador}-${i}`,
        roleTitle: "Gerente",
        email: `pessoa${contador}-${i}@exemplo.com.br`,
        emailVerified: true,
      }),
    );
  }
  return { campanha, leads };
}

/**
 * Escreve histórico de envio real no banco — que é de onde o disjuntor lê.
 *
 * Vai direto no SQL de propósito: é justamente a fonte local que o disjuntor
 * consulta, e um teste que entrega a contagem pronta ao provedor não prova
 * nada sobre a produção.
 */
async function simularHistorico(
  leads: readonly { id: string }[],
  quantosBounces = 0,
) {
  for (const lead of leads) {
    await banco.db.query(
      `insert into messages (tenant_id, lead_id, direction, body, shadow)
       values ($1, $2, 'outbound', 'histórico', false)`,
      [banco.tenantId, lead.id],
    );
  }
  for (let i = 0; i < quantosBounces; i++) {
    await banco.db.query(`update leads set bounced_at = now() where id = $1`, [
      leads[i]!.id,
    ]);
  }
}

function provedorFalso(): ColdEmailProvider & { enviados: string[] } {
  const enviados: string[] = [];
  return {
    enviados,
    async enviar(email) {
      enviados.push(email.email);
      return { enviado: true, externalId: `ext_${enviados.length}`, sombra: false };
    },
    async contarBounces() {
      return null;
    },
  };
}

const escreverEmailFalso = vi.fn(async () => ({
  subject: "Assunto gerado",
  body: "Corpo gerado",
}));

beforeEach(() => {
  escreverEmailFalso.mockClear();
});

describe("enviarLote — caminho feliz", () => {
  it("envia para os leads prontos e os move para contacted", async () => {
    const { campanha, leads } = await cenario(2);
    const provedor = provedorFalso();

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.enviados).toBe(2);
    expect(provedor.enviados).toHaveLength(2);
    for (const lead of leads) {
      const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
      expect(relido?.stage).toBe("contacted");
    }
  });

  it("respeita o teto diário da campanha", async () => {
    const { campanha } = await cenario(5, 2);
    const provedor = provedorFalso();

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.enviados).toBe(2);
    expect(provedor.enviados).toHaveLength(2);
  });
});

describe("enviarLote — supressão", () => {
  it("não envia para endereço suprimido e descarta o lead", async () => {
    const { campanha, leads } = await cenario(1);
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "email", value: leads[0]!.email },
      "descadastro",
    );
    const provedor = provedorFalso();

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.enviados).toBe(0);
    expect(resultado.suprimidos).toBe(1);
    expect(provedor.enviados).toHaveLength(0);

    const relido = await buscarLead(banco.db, banco.tenantId, leads[0]!.id);
    expect(relido?.stage).toBe("discarded");
  });

  it("não gasta chamada de IA para lead suprimido", async () => {
    const { campanha, leads } = await cenario(1);
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "email", value: leads[0]!.email },
      "descadastro",
    );

    await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(escreverEmailFalso).not.toHaveBeenCalled();
  });
});

describe("enviarLote — recusas", () => {
  it("recusa campanha pausada sem enviar nada", async () => {
    const { campanha } = await cenario(2);
    await banco.db.query(`update campaigns set status = 'paused' where id = $1`, [
      campanha.id,
    ]);
    const provedor = provedorFalso();

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.enviados).toBe(0);
    expect(resultado.motivo).toMatch(/não está ativa/i);
    expect(provedor.enviados).toHaveLength(0);
  });

  it("recusa campanha inexistente", async () => {
    const resultado = await enviarLote(
      {
        db: banco.db,
        tenantId: banco.tenantId,
        campaignId: "99999999-9999-9999-9999-999999999999",
        provedor: provedorFalso(),
      },
      { escreverEmail: escreverEmailFalso as never },
    );
    expect(resultado.motivo).toMatch(/não encontrada/i);
  });

  it("registra falha do provedor sem derrubar o lote", async () => {
    const { campanha } = await cenario(2);
    let primeira = true;
    const provedor: ColdEmailProvider = {
      async enviar() {
        if (primeira) {
          primeira = false;
          return { enviado: false, motivo: "recusado pelo fornecedor" };
        }
        return { enviado: true, externalId: "ok", sombra: false };
      },
      async contarBounces() {
        return null;
      },
    };

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.falhas).toBe(1);
    expect(resultado.enviados).toBe(1);
  });
});

describe("enviarLote — isolamento de falha por lead", () => {
  it("um lead cuja transição estoura não impede o envio do seguinte", async () => {
    const { campanha, leads } = await cenario(2);
    const provedor = provedorFalso();

    // A corrida real: outro fluxo move o lead entre a leitura e o UPDATE, e o
    // compare-and-swap de `transicionarLead` não acha linha nenhuma. Aqui isso
    // é simulado derrubando só o UPDATE do primeiro lead.
    const primeiro = leads[0]!.id;
    const dbComCorrida = {
      query: async (texto: string, params?: readonly unknown[]) => {
        if (/update leads set/i.test(texto) && params?.[1] === primeiro) {
          throw new Error("outro fluxo moveu o lead antes");
        }
        return banco.db.query(texto, params);
      },
    } as typeof banco.db;

    const resultado = await enviarLote(
      { db: dbComCorrida, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    // O lote terminou em vez de rejeitar a promessa, e o segundo lead saiu.
    expect(resultado.falhas).toBe(1);
    expect(resultado.enviados).toBe(1);
    expect(provedor.enviados).toHaveLength(2); // os dois e-mails saíram
    expect(await buscarLead(banco.db, banco.tenantId, leads[1]!.id)).toMatchObject({
      stage: "contacted",
    });

    const { rows } = await banco.db.query<{ payload: { leadId: string } }>(
      `select payload from events
       where tenant_id = $1 and kind = 'falha_no_lote'
         and payload->>'leadId' = $2`,
      [banco.tenantId, primeiro],
    );
    expect(rows).toHaveLength(1);
  });

  it("termina o lote mesmo quando nem o evento de falha grava", async () => {
    const { campanha, leads } = await cenario(2);
    const provedor = provedorFalso();
    const primeiro = leads[0]!.id;

    const dbTotalmenteFora = {
      query: async (texto: string, params?: readonly unknown[]) => {
        if (/update leads set/i.test(texto) && params?.[1] === primeiro) {
          throw new Error("banco indisponível");
        }
        if (/insert into events/i.test(texto)) {
          throw new Error("banco indisponível");
        }
        return banco.db.query(texto, params);
      },
    } as typeof banco.db;

    const resultado = await enviarLote(
      { db: dbTotalmenteFora, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.falhas).toBe(1);
    expect(resultado.enviados).toBe(1);
  });
});

describe("enviarLote — disjuntor", () => {
  it("pausa a campanha e não envia quando o bounce local passa do limite", async () => {
    const { campanha, leads } = await cenario(21, 50);
    await simularHistorico(leads, 2); // 2/21 = 9,5%
    const provedor = provedorFalso();

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.disjuntorAberto).toBe(true);
    expect(resultado.enviados).toBe(0);
    expect(provedor.enviados).toHaveLength(0);

    const relida = await buscarCampanha(banco.db, banco.tenantId, campanha.id);
    expect(relida?.status).toBe("paused");
  });

  it("ignora a contagem do fornecedor: ela é do workspace inteiro", async () => {
    const { campanha } = await cenario(1);
    const provedor: ColdEmailProvider = {
      async enviar() {
        return { enviado: true, externalId: "x", sombra: false };
      },
      // Números catastróficos — de outro tenant. Não podem pausar esta campanha.
      async contarBounces() {
        return { enviados: 100, bounces: 90 };
      },
    };

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.disjuntorAberto).toBe(false);
    expect(resultado.enviados).toBe(1);
  });

  it("segue normalmente quando não há histórico nenhum", async () => {
    const { campanha } = await cenario(1);
    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      { escreverEmail: escreverEmailFalso as never },
    );
    expect(resultado.disjuntorAberto).toBe(false);
    expect(resultado.enviados).toBe(1);
  });

  it("avisa quando a amostra é significativa e não há nenhum bounce", async () => {
    const { campanha, leads } = await cenario(20, 50);
    await simularHistorico(leads, 0);

    await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      { escreverEmail: escreverEmailFalso as never },
    );

    const { rows } = await banco.db.query<{ payload: { campaignId: string; enviados: number } }>(
      `select payload from events
       where tenant_id = $1 and kind = 'disjuntor_sem_fonte_de_bounce'
         and payload->>'campaignId' = $2`,
      [banco.tenantId, campanha.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.enviados).toBe(20);
  });

  it("não avisa quando a amostra ainda é pequena", async () => {
    const { campanha, leads } = await cenario(3, 50);
    await simularHistorico(leads, 0);

    await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      { escreverEmail: escreverEmailFalso as never },
    );

    const { rows } = await banco.db.query(
      `select 1 from events
       where tenant_id = $1 and kind = 'disjuntor_sem_fonte_de_bounce'
         and payload->>'campaignId' = $2`,
      [banco.tenantId, campanha.id],
    );
    expect(rows).toHaveLength(0);
  });
});
