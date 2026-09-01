import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";

// `enviarLote` usa `writeFirstEmail` como dependência padrão, que chamaria a
// Claude API de verdade. Este mock existe só para a rota não depender de rede
// — o comportamento de `enviarLote` em si já está exaustivamente testado em
// `tests/sending/enviar-lote.test.ts`; aqui o que importa é a fiação da rota.
vi.mock("../../../src/ai/email-writer.js", () => ({
  writeFirstEmail: vi
    .fn()
    .mockResolvedValue({ subject: "Assunto de teste", body: "Corpo de teste" }),
}));
import { criarCampanha } from "../../../src/db/repositories/campaigns.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import { criarLead, buscarLead } from "../../../src/db/repositories/leads.js";
import {
  tratarEnviarLote,
} from "../../../src/api/handlers/enviar-lote.js";
import { HEADER_SEGREDO_N8N } from "../../../src/api/handlers/processar-resposta.js";

const SEGREDO = "segredo-n8n";

let banco: BancoDeTeste;
let empresaId: string;
let contador = 0;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "96666666000101",
      legalName: "Empresa do lote HTTP",
      tradeName: null,
      website: null,
      city: null,
      uf: null,
      employeeCount: null,
      summary: "Faz coisas.",
      source: "cnpj",
    },
  ]);
  const { rows } = await banco.db.query<{ id: string }>(
    `select id from companies where cnpj = '96666666000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

function deps() {
  return { db: banco.db, tenantId: banco.tenantId, segredo: SEGREDO };
}

function requisicao(segredo: string | null = SEGREDO) {
  const headers: Record<string, string> = {};
  if (segredo !== null) headers[HEADER_SEGREDO_N8N] = segredo;
  return new Request("https://x/campaigns/1/enviar-lote", {
    method: "POST",
    headers,
  });
}

describe("tratarEnviarLote", () => {
  it("recusa com 401 sem o segredo certo", async () => {
    const res = await tratarEnviarLote(requisicao("errado"), banco.campaignId, deps());
    expect(res.status).toBe(401);
  });

  it("devolve 404 para campanha inexistente", async () => {
    const res = await tratarEnviarLote(
      requisicao(),
      "99999999-9999-9999-9999-999999999999",
      deps(),
    );
    expect(res.status).toBe(404);
  });

  it("dispara o lote em modo sombra e devolve o resultado real de enviarLote", async () => {
    contador += 1;
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      name: `Lote HTTP ${contador}`,
      nicheDescription: "indústrias",
      offerDescription: "BI",
      schedulingLink: "https://cal.com/t/30min",
      senderFirstName: "Thiago",
    });
    // campanha já nasce em modo sombra — nenhum envio real sai daqui.
    await criarLead(banco.db, {
      tenantId: banco.tenantId,
      campaignId: campanha.id,
      companyId: empresaId,
      fullName: "Pessoa do Lote",
      roleTitle: "Gerente",
      email: `lotehttp${contador}@exemplo.com.br`,
      emailVerified: true,
    });

    const res = await tratarEnviarLote(requisicao(), campanha.id, deps());
    expect(res.status).toBe(200);

    const corpo = await res.json();
    expect(corpo.enviados).toBe(1);
    expect(corpo.disjuntorAberto).toBe(false);

    const { rows } = await banco.db.query<{ id: string }>(
      `select id from leads where tenant_id = $1 and campaign_id = $2`,
      [banco.tenantId, campanha.id],
    );
    const lead = await buscarLead(banco.db, banco.tenantId, rows[0]!.id);
    expect(lead?.stage).toBe("enriched");
  });
});
