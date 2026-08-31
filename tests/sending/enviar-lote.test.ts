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

describe("enviarLote — disjuntor", () => {
  it("pausa a campanha e não envia quando o bounce passa do limite", async () => {
    const { campanha } = await cenario(2);
    const provedor: ColdEmailProvider = {
      async enviar() {
        return { enviado: true, externalId: "x", sombra: false };
      },
      async contarBounces() {
        return { enviados: 100, bounces: 10 };
      },
    };

    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor },
      { escreverEmail: escreverEmailFalso as never },
    );

    expect(resultado.disjuntorAberto).toBe(true);
    expect(resultado.enviados).toBe(0);

    const relida = await buscarCampanha(banco.db, banco.tenantId, campanha.id);
    expect(relida?.status).toBe("paused");
  });

  it("segue normalmente quando o provedor não sabe informar bounces", async () => {
    const { campanha } = await cenario(1);
    const resultado = await enviarLote(
      { db: banco.db, tenantId: banco.tenantId, campaignId: campanha.id, provedor: provedorFalso() },
      { escreverEmail: escreverEmailFalso as never },
    );
    expect(resultado.disjuntorAberto).toBe(false);
    expect(resultado.enviados).toBe(1);
  });
});
