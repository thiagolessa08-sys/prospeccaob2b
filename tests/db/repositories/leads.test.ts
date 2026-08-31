import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  subirBanco,
  criarTenantVizinho,
  type BancoDeTeste,
} from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import {
  criarLead,
  buscarLead,
  buscarLeadPorEmail,
  marcarBounce,
  transicionarLead,
  incrementarTrocas,
  listarProntosParaContato,
} from "../../../src/db/repositories/leads.js";
import type { Db } from "../../../src/db/port.js";

let banco: BancoDeTeste;
let empresaId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "77777777000101",
      legalName: "Empresa dos leads",
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
    `select id from companies where cnpj = '77777777000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

let contador = 0;
function novoLead(overrides: Partial<Parameters<typeof criarLead>[1]> = {}) {
  contador += 1;
  return {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: empresaId,
    fullName: "Maria Souza",
    roleTitle: "Gerente de TI",
    email: `maria${contador}@empresa.com.br`,
    emailVerified: true,
    ...overrides,
  };
}

describe("criarLead", () => {
  it("cria o lead já no estágio enriched", async () => {
    const lead = await criarLead(banco.db, novoLead());
    expect(lead.stage).toBe("enriched");
    expect(lead.exchange_count).toBe(0);
    expect(lead.needs_human).toBe(false);
  });

  it("recusa empresa de outro tenant, em vez de gravar lead misturado", async () => {
    const vizinho = await criarTenantVizinho(banco.db, "0002");

    await expect(
      criarLead(
        banco.db,
        novoLead({
          companyId: vizinho.companyId,
          email: "cruzado@empresa.com.br",
        }),
      ),
    ).rejects.toThrow(/não pertence ao tenant/i);

    const { rows } = await banco.db.query(
      `select 1 from leads where email = 'cruzado@empresa.com.br'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("transicionarLead", () => {
  it("avança pelo caminho feliz do funil", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const contatado = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "contacted",
    );
    expect(contatado.stage).toBe("contacted");
  });

  it("recusa uma transição inválida antes de tocar o banco", async () => {
    const lead = await criarLead(banco.db, novoLead());
    await expect(
      transicionarLead(banco.db, banco.tenantId, lead.id, "meeting_booked"),
    ).rejects.toThrow(/Transição de estágio inválida/);

    const inalterado = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(inalterado?.stage).toBe("enriched");
  });

  it("grava o motivo do descarte", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const descartado = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "discarded",
      { discardReason: "recusa do lead" },
    );
    expect(descartado.stage).toBe("discarded");
    expect(descartado.discard_reason).toBe("recusa do lead");
  });

  it("marca needs_human junto com o motivo do repasse", async () => {
    const lead = await criarLead(banco.db, novoLead());
    await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted");
    const emConversa = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "in_conversation",
      { needsHuman: true, handoffReason: "conversa longa sem desfecho" },
    );
    expect(emConversa.needs_human).toBe(true);
    expect(emConversa.handoff_reason).toBe("conversa longa sem desfecho");
  });

  it("grava a data de retomada", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const quando = new Date("2026-12-01T12:00:00.000Z");
    await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted", {
      resumeAt: quando,
    });
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido!.resume_at!.toISOString()).toBe(quando.toISOString());
  });

  it("recusa a escrita quando outro fluxo move o lead entre a leitura e a escrita", async () => {
    const lead = await criarLead(banco.db, novoLead());

    // O PGlite é uma conexão só e serializa tudo, então a corrida real —
    // webhook de resposta e varredura de follow-up tocando o mesmo lead no
    // mesmo segundo, com o `pg.Pool` distribuindo cinco conexões — não
    // acontece aqui sozinha. Interpomos no porte para produzir exatamente a
    // intercalação: alguém escreve entre o SELECT e o UPDATE.
    let jaInterferiu = false;
    const dbComCorrida: Db = {
      query: async <T = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ) => {
        const resultado = await banco.db.query<T>(text, params);
        if (!jaInterferiu && /from leads/i.test(text)) {
          jaInterferiu = true;
          await banco.db.query(
            `update leads set stage = 'contacted' where id = $1`,
            [lead.id],
          );
        }
        return resultado;
      },
    };

    await expect(
      transicionarLead(dbComCorrida, banco.tenantId, lead.id, "contacted"),
    ).rejects.toThrow(/mudou de estágio ao mesmo tempo/i);

    // O estágio é o que o outro fluxo escreveu — a segunda escrita não passou.
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.stage).toBe("contacted");
    expect(jaInterferiu).toBe(true);
  });

  it("lança quando o lead não existe", async () => {
    await expect(
      transicionarLead(
        banco.db,
        banco.tenantId,
        "99999999-9999-9999-9999-999999999999",
        "contacted",
      ),
    ).rejects.toThrow(/não encontrado/i);
  });
});

describe("incrementarTrocas", () => {
  it("soma um e devolve o valor novo", async () => {
    const lead = await criarLead(banco.db, novoLead());
    expect(await incrementarTrocas(banco.db, banco.tenantId, lead.id)).toBe(1);
    expect(await incrementarTrocas(banco.db, banco.tenantId, lead.id)).toBe(2);
  });
});

describe("listarProntosParaContato", () => {
  it("devolve só leads enriched com e-mail verificado", async () => {
    const verificado = await criarLead(banco.db, novoLead());
    const naoVerificado = await criarLead(
      banco.db,
      novoLead({ emailVerified: false }),
    );
    const jaContatado = await criarLead(banco.db, novoLead());
    await transicionarLead(banco.db, banco.tenantId, jaContatado.id, "contacted");

    const prontos = await listarProntosParaContato(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      50,
    );
    const ids = prontos.map((l) => l.id);
    expect(ids).toContain(verificado.id);
    expect(ids).not.toContain(naoVerificado.id);
    expect(ids).not.toContain(jaContatado.id);
  });

  it("respeita o limite pedido", async () => {
    await criarLead(banco.db, novoLead());
    await criarLead(banco.db, novoLead());
    const prontos = await listarProntosParaContato(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      1,
    );
    expect(prontos).toHaveLength(1);
  });
});

describe("buscarLeadPorEmail", () => {
  it("acha o lead pelo endereço exato", async () => {
    const lead = await criarLead(banco.db, novoLead({ email: "busca@exemplo.com" }));
    const achado = await buscarLeadPorEmail(
      banco.db,
      banco.tenantId,
      "busca@exemplo.com",
    );
    expect(achado?.id).toBe(lead.id);
  });

  it("ignora maiúsculas e espaços, como o índice único faz", async () => {
    const lead = await criarLead(banco.db, novoLead({ email: "Caixa@Exemplo.com" }));
    const achado = await buscarLeadPorEmail(
      banco.db,
      banco.tenantId,
      "  caixa@exemplo.com ",
    );
    expect(achado?.id).toBe(lead.id);
  });

  it("devolve null quando não existe", async () => {
    const achado = await buscarLeadPorEmail(
      banco.db,
      banco.tenantId,
      "ninguem@exemplo.com",
    );
    expect(achado).toBeNull();
  });

  it("não devolve lead de outro tenant", async () => {
    const lead = await criarLead(banco.db, novoLead({ email: "outro@exemplo.com" }));
    const outroTenant = "55555555-5555-5555-5555-555555555555";
    await banco.db.query(`insert into tenants (id, name) values ($1, 'Vizinho')`, [
      outroTenant,
    ]);
    const achado = await buscarLeadPorEmail(
      banco.db,
      outroTenant,
      "outro@exemplo.com",
    );
    expect(achado).toBeNull();
    expect(lead.id).toBeDefined();
  });

  it("devolve null para e-mail vazio, sem consultar", async () => {
    expect(await buscarLeadPorEmail(banco.db, banco.tenantId, "  ")).toBeNull();
  });
});

describe("marcarBounce", () => {
  it("grava a data do bounce", async () => {
    const lead = await criarLead(banco.db, novoLead({ email: "bounce1@exemplo.com" }));
    await marcarBounce(banco.db, banco.tenantId, lead.id);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.bounced_at).toBeInstanceOf(Date);
  });

  it("preserva a data do primeiro bounce numa segunda marcação", async () => {
    const lead = await criarLead(banco.db, novoLead({ email: "bounce2@exemplo.com" }));
    await marcarBounce(banco.db, banco.tenantId, lead.id);
    const primeiro = await buscarLead(banco.db, banco.tenantId, lead.id);

    await new Promise((r) => setTimeout(r, 20));
    await marcarBounce(banco.db, banco.tenantId, lead.id);
    const segundo = await buscarLead(banco.db, banco.tenantId, lead.id);

    expect(segundo!.bounced_at!.getTime()).toBe(primeiro!.bounced_at!.getTime());
  });

  it("não afeta lead de outro tenant", async () => {
    const lead = await criarLead(banco.db, novoLead({ email: "bounce3@exemplo.com" }));
    const outroTenant = "66666666-6666-6666-6666-666666666666";
    await banco.db.query(`insert into tenants (id, name) values ($1, 'Vizinho 2')`, [
      outroTenant,
    ]);
    await marcarBounce(banco.db, outroTenant, lead.id);

    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido?.bounced_at).toBeNull();
  });
});
