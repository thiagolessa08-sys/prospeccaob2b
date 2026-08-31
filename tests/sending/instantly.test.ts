import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { salvarEmpresas } from "../../src/db/repositories/companies.js";
import { criarLead } from "../../src/db/repositories/leads.js";
import { carregarConversa } from "../../src/db/repositories/messages.js";
import { criarProvedorInstantly } from "../../src/sending/instantly.js";
import { respostaJson, respostaVazia, fetchFalso } from "../helpers/http-mock.js";

let banco: BancoDeTeste;
let leadId: string;

const CHAVE = "chave-instantly";
const CAMPANHA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "94444444000101",
      legalName: "Empresa do Instantly",
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
    `select id from companies where cnpj = '94444444000101'`,
  );
  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: rows[0]!.id,
    fullName: "João Lima",
    roleTitle: "Gerente",
    email: "joao@instantly.com.br",
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
    email: "joao@instantly.com.br",
    primeiroNome: "João",
    sobrenome: "Lima",
    empresa: "Empresa do Instantly",
    site: "https://instantly.com.br",
    assunto: "Integração de dados",
    corpo: "Olá João,\n\nPrimeiro parágrafo.\n\nSegundo parágrafo.",
    ...overrides,
  } as never;
}

function provedor(fake: ReturnType<typeof fetchFalso>) {
  return criarProvedorInstantly(
    { apiKey: CHAVE, campanhaInstantly: CAMPANHA, db: banco.db },
    { fetch: fake },
  );
}

describe("criarProvedorInstantly — enviar", () => {
  it("relata sucesso com o id devolvido pelo Instantly", async () => {
    const fake = fetchFalso([respostaJson({ id: "lead_123" }, 200)]);
    const resultado = await provedor(fake).enviar(email());

    expect(resultado).toEqual({
      enviado: true,
      externalId: "lead_123",
      sombra: false,
    });
  });

  it("manda assunto e corpo em custom_variables, que é o contorno do template", async () => {
    const fake = fetchFalso([respostaJson({ id: "lead_124" })]);
    await provedor(fake).enviar(
      email({ assunto: "Assunto da IA", corpo: "Corpo\n\nda IA" }),
    );

    const corpoEnviado = JSON.parse(
      (fake.opcoes[0]?.body as string) ?? "{}",
    ) as Record<string, unknown>;

    expect(corpoEnviado.campaign).toBe(CAMPANHA);
    expect(corpoEnviado.email).toBe("joao@instantly.com.br");
    expect(corpoEnviado.first_name).toBe("João");
    expect(corpoEnviado.last_name).toBe("Lima");
    expect(corpoEnviado.company_name).toBe("Empresa do Instantly");
    expect(corpoEnviado.custom_variables).toEqual({
      assunto_email: "Assunto da IA",
      corpo_email: "Corpo\n\nda IA",
    });
  });

  it("autentica por Bearer no header", async () => {
    const fake = fetchFalso([respostaJson({ id: "lead_125" })]);
    await provedor(fake).enviar(email());

    const headers = new Headers(fake.opcoes[0]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CHAVE}`);
    expect(fake.chamadas[0]).toBe("https://api.instantly.ai/api/v2/leads");
  });

  it("grava a mensagem enviada, sem marca de sombra", async () => {
    const fake = fetchFalso([respostaJson({ id: "lead_126" })]);
    await provedor(fake).enviar(email({ assunto: "Gravada de verdade" }));

    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    const gravada = conversa.find((m) => m.subject === "Gravada de verdade");
    expect(gravada?.shadow).toBe(false);
    expect(gravada?.external_id).toBe("lead_126");
  });

  it("relata falha sem lançar quando o Instantly recusa", async () => {
    const fake = fetchFalso([respostaJson({ error: "sem crédito" }, 402)]);
    const resultado = await provedor(fake).enviar(email());

    expect(resultado.enviado).toBe(false);
    if (resultado.enviado) throw new Error("esperava falha");
    expect(resultado.motivo).toMatch(/402/);
  });

  it("não grava mensagem quando o envio falhou", async () => {
    const fake = fetchFalso([respostaJson({ error: "ruim" }, 400)]);
    await provedor(fake).enviar(email({ assunto: "Nunca gravada" }));

    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    expect(conversa.find((m) => m.subject === "Nunca gravada")).toBeUndefined();
  });

  it("omite campos nulos em vez de mandar null", async () => {
    const fake = fetchFalso([respostaJson({ id: "lead_127" })]);
    await provedor(fake).enviar(
      email({ primeiroNome: null, sobrenome: null, empresa: null, site: null }),
    );

    const corpoEnviado = JSON.parse(
      (fake.opcoes[0]?.body as string) ?? "{}",
    ) as Record<string, unknown>;
    expect(corpoEnviado).not.toHaveProperty("first_name");
    expect(corpoEnviado).not.toHaveProperty("company_name");
  });
});

describe("criarProvedorInstantly — contarBounces", () => {
  it("lê as contagens da analytics", async () => {
    const fake = fetchFalso([
      respostaJson([{ campaign_id: CAMPANHA, emails_sent_count: 120, bounced_count: 5 }]),
    ]);
    const contagem = await provedor(fake).contarBounces(CAMPANHA);
    expect(contagem).toEqual({ enviados: 120, bounces: 5 });
  });

  it("devolve null quando a analytics não traz a campanha", async () => {
    const fake = fetchFalso([respostaJson([])]);
    expect(await provedor(fake).contarBounces(CAMPANHA)).toBeNull();
  });

  it("devolve null em falha, em vez de derrubar o disjuntor", async () => {
    const fake = fetchFalso([respostaVazia(500), respostaVazia(500)]);
    expect(await provedor(fake).contarBounces(CAMPANHA)).toBeNull();
  });
});
