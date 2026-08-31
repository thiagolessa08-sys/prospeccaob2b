import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  subirBanco,
  criarTenantVizinho,
  type BancoDeTeste,
} from "../../helpers/pg.js";
import {
  salvarEmpresas,
  listarPendentesDeEnriquecimento,
  marcarEnriquecimento,
  type NovaEmpresa,
} from "../../../src/db/repositories/companies.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

function empresa(overrides: Partial<NovaEmpresa> = {}): NovaEmpresa {
  return {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    cnpj: null,
    legalName: "Alfa Alimentos LTDA",
    tradeName: "Alfa Alimentos",
    website: "https://alfa.com.br",
    city: "Joinville",
    uf: "SC",
    employeeCount: 80,
    summary: null,
    source: "cnpj",
    ...overrides,
  };
}

describe("salvarEmpresas", () => {
  it("insere um lote e conta o que entrou", async () => {
    const resultado = await salvarEmpresas(banco.db, [
      empresa({ cnpj: "11111111000101", legalName: "Um" }),
      empresa({ cnpj: "11111111000202", legalName: "Dois" }),
    ]);
    expect(resultado).toEqual({ inseridas: 2, ignoradas: 0 });
  });

  it("ignora CNPJ que já existe, sem falhar o lote inteiro", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "22222222000101", legalName: "Original" }),
    ]);
    const resultado = await salvarEmpresas(banco.db, [
      empresa({ cnpj: "22222222000101", legalName: "Repetida" }),
      empresa({ cnpj: "22222222000202", legalName: "Nova" }),
    ]);
    expect(resultado).toEqual({ inseridas: 1, ignoradas: 1 });
  });

  it("mantém o registro original quando ignora a duplicata", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "33333333000101", legalName: "Nome original" }),
    ]);
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "33333333000101", legalName: "Nome sobrescrito" }),
    ]);
    const { rows } = await banco.db.query<{ legal_name: string }>(
      `select legal_name from companies where cnpj = '33333333000101'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.legal_name).toBe("Nome original");
  });

  it("aceita várias empresas sem CNPJ no mesmo lote", async () => {
    const resultado = await salvarEmpresas(banco.db, [
      empresa({ cnpj: null, legalName: "Sem CNPJ A", source: "maps" }),
      empresa({ cnpj: null, legalName: "Sem CNPJ B", source: "maps" }),
    ]);
    expect(resultado.inseridas).toBe(2);
  });

  it("não faz nada com lote vazio", async () => {
    const resultado = await salvarEmpresas(banco.db, []);
    expect(resultado).toEqual({ inseridas: 0, ignoradas: 0 });
  });

  it("recusa campanha de outro tenant, em vez de gravar linha misturada", async () => {
    const vizinho = await criarTenantVizinho(banco.db, "0001");

    await expect(
      salvarEmpresas(banco.db, [
        empresa({
          campaignId: vizinho.campaignId,
          cnpj: "99999999000101",
          legalName: "Empresa cruzada",
        }),
      ]),
    ).rejects.toThrow(/não pertence ao tenant/i);

    const { rows } = await banco.db.query(
      `select 1 from companies where cnpj = '99999999000101'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("listarPendentesDeEnriquecimento", () => {
  it("devolve só quem está pendente, respeitando o limite", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "44444444000101", legalName: "Pendente 1" }),
      empresa({ cnpj: "44444444000202", legalName: "Pendente 2" }),
      empresa({ cnpj: "44444444000303", legalName: "Pendente 3" }),
    ]);
    const pendentes = await listarPendentesDeEnriquecimento(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      2,
    );
    expect(pendentes).toHaveLength(2);
    for (const p of pendentes) expect(p.enrichment_status).toBe("pending");
  });

  it("não devolve empresa já enriquecida", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "55555555000101", legalName: "Já enriquecida" }),
    ]);
    const { rows } = await banco.db.query<{ id: string }>(
      `select id from companies where cnpj = '55555555000101'`,
    );
    await marcarEnriquecimento(banco.db, banco.tenantId, rows[0]!.id, "enriched");

    const pendentes = await listarPendentesDeEnriquecimento(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      50,
    );
    expect(pendentes.map((p) => p.id)).not.toContain(rows[0]!.id);
  });

  it("não devolve empresa cujo enriquecimento falhou", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "66666666000101", legalName: "Falhou" }),
    ]);
    const { rows } = await banco.db.query<{ id: string }>(
      `select id from companies where cnpj = '66666666000101'`,
    );
    await marcarEnriquecimento(banco.db, banco.tenantId, rows[0]!.id, "failed");

    const pendentes = await listarPendentesDeEnriquecimento(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      50,
    );
    expect(pendentes.map((p) => p.id)).not.toContain(rows[0]!.id);
  });
});
