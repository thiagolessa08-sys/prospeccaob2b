import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import { criarLead } from "../../../src/db/repositories/leads.js";
import { registrarEvento } from "../../../src/db/repositories/events.js";

let banco: BancoDeTeste;
let leadId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "12121212000101",
      legalName: "Empresa dos eventos",
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
    `select id from companies where cnpj = '12121212000101'`,
  );
  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: rows[0]!.id,
    fullName: "Ana",
    roleTitle: "Sócia",
    email: "ana@eventos.com.br",
    emailVerified: true,
  });
  leadId = lead.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

interface LinhaEvento {
  tenant_id: string | null;
  lead_id: string | null;
  kind: string;
  payload: unknown;
}

async function lerEvento(kind: string): Promise<LinhaEvento> {
  const { rows } = await banco.db.query<LinhaEvento>(
    `select tenant_id, lead_id, kind, payload from events where kind = $1`,
    [kind],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("registrarEvento", () => {
  it("grava um evento amarrado ao tenant e ao lead", async () => {
    await registrarEvento(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      kind: "email_enviado",
      payload: { assunto: "Integração de dados" },
    });

    const linha = await lerEvento("email_enviado");
    expect(linha.tenant_id).toBe(banco.tenantId);
    expect(linha.lead_id).toBe(leadId);
  });

  it("grava falha anterior à resolução do tenant, com os dois ids nulos", async () => {
    // O motivo de `events` não ter chave estrangeira nenhuma. Um webhook com
    // payload irreconhecível chega antes de existir tenant ou lead
    // resolvível: se este caminho falhasse, o log sumiria exatamente quando é
    // mais útil.
    await registrarEvento(banco.db, {
      tenantId: null,
      leadId: null,
      kind: "webhook_irreconhecivel",
      payload: { corpo: "<html>erro do provedor</html>" },
    });

    const linha = await lerEvento("webhook_irreconhecivel");
    expect(linha.tenant_id).toBeNull();
    expect(linha.lead_id).toBeNull();
  });

  it("transforma payload ausente em NULL do SQL, não na string \"undefined\"", async () => {
    await registrarEvento(banco.db, {
      tenantId: banco.tenantId,
      leadId: null,
      kind: "varredura_iniciada",
    });

    const linha = await lerEvento("varredura_iniciada");
    expect(linha.payload).toBeNull();

    // A confirmação que importa: o Postgres enxerga NULL de verdade. Se a
    // string "undefined" tivesse sido serializada, o JSONB guardaria o texto
    // e `is null` daria falso.
    const { rows } = await banco.db.query<{ nulo: boolean }>(
      `select payload is null as nulo from events where kind = 'varredura_iniciada'`,
    );
    expect(rows[0]!.nulo).toBe(true);
  });

  it("faz o payload estruturado dar a volta pelo JSONB", async () => {
    const tentativas = [
      { fonte: "cnpj_qsa", resultado: "vazio" },
      { fonte: "hunter_finder", resultado: "acertou", detalhe: null },
    ];

    await registrarEvento(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      kind: "enriquecimento_medido",
      payload: { tentativas, creditos: 1, acentuação: "sim, com acento" },
    });

    const linha = await lerEvento("enriquecimento_medido");
    expect(linha.payload).toEqual({
      tentativas,
      creditos: 1,
      acentuação: "sim, com acento",
    });
  });

  it("aceita o mesmo tipo de evento várias vezes: é trilha, não estado", async () => {
    await registrarEvento(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      kind: "follow_up_agendado",
      payload: { tentativa: 1 },
    });
    await registrarEvento(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      kind: "follow_up_agendado",
      payload: { tentativa: 2 },
    });

    const { rows } = await banco.db.query<{ payload: { tentativa: number } }>(
      `select payload from events where kind = 'follow_up_agendado'
       order by payload->>'tentativa'`,
    );
    expect(rows.map((r) => r.payload.tentativa)).toEqual([1, 2]);
  });
});
