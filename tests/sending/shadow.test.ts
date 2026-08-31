import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { salvarEmpresas } from "../../src/db/repositories/companies.js";
import { criarLead } from "../../src/db/repositories/leads.js";
import { carregarConversa } from "../../src/db/repositories/messages.js";
import { adicionarSupressao } from "../../src/db/repositories/suppression.js";
import { criarProvedorDeSombra } from "../../src/sending/shadow.js";

let banco: BancoDeTeste;
let leadId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "93333333000101",
      legalName: "Empresa da sombra",
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
    `select id from companies where cnpj = '93333333000101'`,
  );
  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: rows[0]!.id,
    fullName: "Maria Souza",
    roleTitle: "Diretora",
    email: "maria@sombra.com.br",
    emailVerified: true,
  });
  leadId = lead.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

function email(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: banco.tenantId,
    leadId,
    email: "maria@sombra.com.br",
    primeiroNome: "Maria",
    sobrenome: "Souza",
    empresa: "Empresa da sombra",
    site: "https://sombra.com.br",
    assunto: "Integração de dados",
    corpo: "Olá Maria,\n\nVi que a Empresa...",
    ...overrides,
  } as Parameters<
    ReturnType<typeof criarProvedorDeSombra>["enviar"]
  >[0];
}

describe("provedor de sombra", () => {
  it("se declara em modo sombra", () => {
    expect(criarProvedorDeSombra(banco.db).modo).toBe("shadow");
  });

  it("relata sucesso marcado como sombra, sem external id", async () => {
    const provedor = criarProvedorDeSombra(banco.db);
    const resultado = await provedor.enviar(email());

    expect(resultado).toEqual({
      enviado: true,
      externalId: null,
      sombra: true,
    });
  });

  it("grava a mensagem com a marca de sombra", async () => {
    const provedor = criarProvedorDeSombra(banco.db);
    await provedor.enviar(
      email({ assunto: "Assunto gravado", corpo: "Corpo gravado" }),
    );

    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    const gravada = conversa.find((m) => m.subject === "Assunto gravado");
    expect(gravada).toBeDefined();
    expect(gravada!.shadow).toBe(true);
    expect(gravada!.direction).toBe("outbound");
    expect(gravada!.body).toBe("Corpo gravado");
  });

  it("registra um evento dizendo que nada saiu", async () => {
    const provedor = criarProvedorDeSombra(banco.db);
    await provedor.enviar(email({ assunto: "Com evento" }));

    const { rows } = await banco.db.query<{ kind: string; payload: unknown }>(
      `select kind, payload from events
       where tenant_id = $1 and kind = 'envio_em_sombra'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.kind).toBe("envio_em_sombra");
  });

  it("estoura antes de gravar qualquer coisa para endereço suprimido", async () => {
    const provedor = criarProvedorDeSombra(banco.db, {
      carregarRegras: async () => [
        { kind: "email", value: "maria@sombra.com.br" },
      ],
    });

    await expect(
      provedor.enviar(email({ assunto: "Nunca ensaiada" })),
    ).rejects.toThrow(/suprimido ou é inválido/i);

    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    expect(conversa.find((m) => m.subject === "Nunca ensaiada")).toBeUndefined();
  });

  it("por padrão consulta a lista de supressão do próprio banco", async () => {
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "domain", value: "sombra.com.br" },
      "descadastro",
    );

    await expect(
      criarProvedorDeSombra(banco.db).enviar(email({ assunto: "Nem ensaio" })),
    ).rejects.toThrow(/suprimido ou é inválido/i);

    await banco.db.query(
      `delete from suppression_list where tenant_id = $1 and value = $2`,
      [banco.tenantId, "sombra.com.br"],
    );
  });

  it("não sabe informar bounces", async () => {
    const provedor = criarProvedorDeSombra(banco.db);
    expect(await provedor.contarBounces()).toBeNull();
  });
});
