import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";
import { salvarEmpresas } from "../../src/db/repositories/companies.js";
import { criarLead } from "../../src/db/repositories/leads.js";
import { carregarConversa } from "../../src/db/repositories/messages.js";
import { adicionarSupressao } from "../../src/db/repositories/suppression.js";
import { criarProvedorInstantly } from "../../src/sending/instantly.js";
import { respostaJson, respostaVazia, fetchFalso } from "../helpers/http-mock.js";

let banco: BancoDeTeste;
let leadId: string;

const CHAVE = "chave-instantly";
const CAMPANHA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PREMISSA = "2026-08-31, suíte de testes";

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
    {
      apiKey: CHAVE,
      campanhaInstantly: CAMPANHA,
      db: banco.db,
      premissaValidadaEm: PREMISSA,
    },
    { fetch: fake },
  );
}

describe("criarProvedorInstantly — trava da premissa", () => {
  it("recusa a construção quando a premissa não foi validada", () => {
    expect(() =>
      criarProvedorInstantly({
        apiKey: CHAVE,
        campanhaInstantly: CAMPANHA,
        db: banco.db,
        premissaValidadaEm: "",
      }),
    ).toThrow(/premissa das custom variables não foi validada/i);
  });

  it("recusa também quando a nota é só espaço em branco", () => {
    expect(() =>
      criarProvedorInstantly({
        apiKey: CHAVE,
        campanhaInstantly: CAMPANHA,
        db: banco.db,
        premissaValidadaEm: "   ",
      }),
    ).toThrow(/Task 5, Step 1/);
  });

  it("aceita quando alguém registrou a validação", () => {
    expect(() =>
      criarProvedorInstantly({
        apiKey: CHAVE,
        campanhaInstantly: CAMPANHA,
        db: banco.db,
        premissaValidadaEm: PREMISSA,
      }),
    ).not.toThrow();
  });
});

describe("criarProvedorInstantly — enviar", () => {
  it("se declara em modo live", () => {
    expect(provedor(fetchFalso([])).modo).toBe("live");
  });

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

  it("relata sucesso e registra a inconsistência quando a gravação falha", async () => {
    const fake = fetchFalso([respostaJson({ id: "lead_gravacao" })]);
    const dbQuebrado = {
      query: async (texto: string, params?: readonly unknown[]) => {
        if (/insert into messages/i.test(texto)) {
          throw new Error("banco indisponível");
        }
        return banco.db.query(texto, params);
      },
    } as typeof banco.db;

    const provedor = criarProvedorInstantly(
      {
        apiKey: CHAVE,
        campanhaInstantly: CAMPANHA,
        db: dbQuebrado,
        premissaValidadaEm: PREMISSA,
      },
      { fetch: fake },
    );

    const resultado = await provedor.enviar(
      email({ assunto: "Saiu mas não gravou" }),
    );

    // O e-mail saiu: relatar falha faria o lote reenviar.
    expect(resultado).toEqual({
      enviado: true,
      externalId: "lead_gravacao",
      sombra: false,
    });

    const { rows } = await banco.db.query<{ payload: { assunto: string } }>(
      `select payload from events
       where tenant_id = $1 and kind = 'envio_sem_registro'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.payload.assunto).toBe("Saiu mas não gravou");
  });

  it("não repete o POST de criação, que não é idempotente", async () => {
    // Duas respostas previstas; se o adaptador tentasse de novo, a segunda
    // seria consumida e o teste veria duas chamadas.
    const fake = fetchFalso([respostaVazia(502), respostaVazia(502)]);
    const resultado = await provedor(fake).enviar(email());

    expect(fake.chamadas).toHaveLength(1);
    expect(resultado.enviado).toBe(false);
  });

  it("registra a duplicata quando o external_id já existe, e ainda relata sucesso", async () => {
    const primeira = fetchFalso([respostaJson({ id: "lead_repetido" })]);
    await provedor(primeira).enviar(email({ assunto: "Primeira vez" }));

    const segunda = fetchFalso([respostaJson({ id: "lead_repetido" })]);
    const resultado = await provedor(segunda).enviar(
      email({ assunto: "Segunda vez" }),
    );

    // O e-mail saiu em algum momento: relatar falha faria o lote reenviar.
    expect(resultado).toEqual({
      enviado: true,
      externalId: "lead_repetido",
      sombra: false,
    });

    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    expect(conversa.filter((m) => m.external_id === "lead_repetido")).toHaveLength(1);
    expect(conversa.find((m) => m.subject === "Segunda vez")).toBeUndefined();

    const { rows } = await banco.db.query<{ payload: { externalId: string } }>(
      `select payload from events
       where tenant_id = $1 and kind = 'envio_duplicado_ignorado'
       order by created_at desc limit 1`,
      [banco.tenantId],
    );
    expect(rows[0]?.payload.externalId).toBe("lead_repetido");
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

describe("criarProvedorInstantly — trava de supressão na última milha", () => {
  it("estoura antes de qualquer HTTP ou gravação para endereço suprimido", async () => {
    const fake = fetchFalso([respostaJson({ id: "nunca_criado" })]);
    const provedorComRegra = criarProvedorInstantly(
      {
        apiKey: CHAVE,
        campanhaInstantly: CAMPANHA,
        db: banco.db,
        premissaValidadaEm: PREMISSA,
        carregarRegras: async () => [
          { kind: "email", value: "joao@instantly.com.br" },
        ],
      },
      { fetch: fake },
    );

    await expect(
      provedorComRegra.enviar(email({ assunto: "Bloqueado na fronteira" })),
    ).rejects.toThrow(/suprimido ou é inválido/i);

    expect(fake.chamadas).toHaveLength(0);
    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    expect(
      conversa.find((m) => m.subject === "Bloqueado na fronteira"),
    ).toBeUndefined();
  });

  it("bloqueia também pelo domínio suprimido", async () => {
    const fake = fetchFalso([]);
    const provedorComRegra = criarProvedorInstantly(
      {
        apiKey: CHAVE,
        campanhaInstantly: CAMPANHA,
        db: banco.db,
        premissaValidadaEm: PREMISSA,
        carregarRegras: async () => [
          { kind: "domain", value: "instantly.com.br" },
        ],
      },
      { fetch: fake },
    );

    await expect(provedorComRegra.enviar(email())).rejects.toThrow(
      /suprimido ou é inválido/i,
    );
    expect(fake.chamadas).toHaveLength(0);
  });

  it("por padrão consulta a lista de supressão do próprio banco", async () => {
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "email", value: "joao@instantly.com.br" },
      "descadastro",
    );
    const fake = fetchFalso([]);

    await expect(provedor(fake).enviar(email())).rejects.toThrow(
      /suprimido ou é inválido/i,
    );
    expect(fake.chamadas).toHaveLength(0);

    await banco.db.query(
      `delete from suppression_list where tenant_id = $1 and value = $2`,
      [banco.tenantId, "joao@instantly.com.br"],
    );
  });
});

describe("criarProvedorInstantly — contarBounces", () => {
  it("lê as contagens da analytics", async () => {
    const fake = fetchFalso([
      respostaJson([{ campaign_id: CAMPANHA, emails_sent_count: 120, bounced_count: 5 }]),
    ]);
    const contagem = await provedor(fake).contarBounces();
    expect(contagem).toEqual({ enviados: 120, bounces: 5 });
  });

  it("consulta a campanha do Instantly, não a nossa", async () => {
    const fake = fetchFalso([
      respostaJson([{ campaign_id: CAMPANHA, emails_sent_count: 40, bounced_count: 2 }]),
    ]);
    const contagem = await provedor(fake).contarBounces();

    // O id na query é o do fornecedor. Se voltasse a ser o UUID do nosso
    // banco, o `find` nunca casaria e o disjuntor ficaria cego.
    expect(fake.chamadas[0]).toContain(`id=${CAMPANHA}`);
    expect(contagem).toEqual({ enviados: 40, bounces: 2 });
  });

  it("ignora linhas de outra campanha do workspace", async () => {
    const fake = fetchFalso([
      respostaJson([
        { campaign_id: "outra-campanha", emails_sent_count: 999, bounced_count: 500 },
      ]),
    ]);
    expect(await provedor(fake).contarBounces()).toBeNull();
  });

  it("devolve null quando a analytics não traz a campanha", async () => {
    const fake = fetchFalso([respostaJson([])]);
    expect(await provedor(fake).contarBounces()).toBeNull();
  });

  it("devolve null em falha, em vez de derrubar o disjuntor", async () => {
    const fake = fetchFalso([respostaVazia(500), respostaVazia(500)]);
    expect(await provedor(fake).contarBounces()).toBeNull();
  });
});
