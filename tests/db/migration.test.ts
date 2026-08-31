import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

describe("migration", () => {
  it("cria as sete tabelas", async () => {
    const { rows } = await banco.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "campaigns",
      "companies",
      "events",
      "leads",
      "messages",
      "suppression_list",
      "tenants",
    ]);
  });

  it("ativa Row Level Security em todas as tabelas", async () => {
    const { rows } = await banco.db.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    expect(rows.length).toBe(7);
    for (const tabela of rows) {
      expect(
        tabela.relrowsecurity,
        `RLS desligado em ${tabela.relname}`,
      ).toBe(true);
    }
  });

  it("não define nenhuma policy, mantendo o banco fechado por padrão", async () => {
    const { rows } = await banco.db.query(
      `select policyname from pg_policies where schemaname = 'public'`,
    );
    expect(rows).toEqual([]);
  });
});

describe("constraints do schema", () => {
  it("barra CNPJ duplicado no mesmo tenant", async () => {
    const inserir = (nome: string) =>
      banco.db.query(
        `insert into companies (tenant_id, campaign_id, legal_name, source, cnpj)
         values ($1, $2, $3, 'cnpj', '11222333000181')`,
        [banco.tenantId, banco.campaignId, nome],
      );
    await inserir("Alfa LTDA");
    await expect(inserir("Alfa duplicada")).rejects.toThrow();
  });

  it("permite várias empresas sem CNPJ no mesmo tenant", async () => {
    const inserir = (nome: string) =>
      banco.db.query(
        `insert into companies (tenant_id, campaign_id, legal_name, source)
         values ($1, $2, $3, 'maps')`,
        [banco.tenantId, banco.campaignId, nome],
      );
    await inserir("Sem CNPJ um");
    await expect(inserir("Sem CNPJ dois")).resolves.toBeDefined();
  });

  it("trata e-mail de lead como único ignorando maiúsculas", async () => {
    const { rows } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do e-mail', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const empresaId = rows[0]!.id;
    const inserir = (email: string) =>
      banco.db.query(
        `insert into leads (tenant_id, campaign_id, company_id, email)
         values ($1, $2, $3, $4)`,
        [banco.tenantId, banco.campaignId, empresaId, email],
      );
    await inserir("Maria@Alfa.com");
    await expect(inserir("maria@alfa.com")).rejects.toThrow();
  });

  it("atualiza updated_at do lead a cada update", async () => {
    const { rows: criada } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do gatilho', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const { rows: lead } = await banco.db.query<{
      id: string;
      updated_at: Date;
    }>(
      `insert into leads (tenant_id, campaign_id, company_id, email)
       values ($1, $2, $3, 'gatilho@exemplo.com')
       returning id, updated_at`,
      [banco.tenantId, banco.campaignId, criada[0]!.id],
    );

    await new Promise((r) => setTimeout(r, 20));
    await banco.db.query(`update leads set full_name = 'Novo Nome' where id = $1`, [
      lead[0]!.id,
    ]);

    const { rows: depois } = await banco.db.query<{ updated_at: Date }>(
      `select updated_at from leads where id = $1`,
      [lead[0]!.id],
    );
    expect(depois[0]!.updated_at.getTime()).toBeGreaterThan(
      lead[0]!.updated_at.getTime(),
    );
  });

  it("barra a reentrega do mesmo webhook", async () => {
    const { rows: empresa } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do webhook', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const { rows: lead } = await banco.db.query<{ id: string }>(
      `insert into leads (tenant_id, campaign_id, company_id, email)
       values ($1, $2, $3, 'webhook@exemplo.com') returning id`,
      [banco.tenantId, banco.campaignId, empresa[0]!.id],
    );
    const inserir = () =>
      banco.db.query(
        `insert into messages (tenant_id, lead_id, direction, body, external_id)
         values ($1, $2, 'inbound', 'olá', 'evt_repetido')`,
        [banco.tenantId, lead[0]!.id],
      );
    await inserir();
    await expect(inserir()).rejects.toThrow();
  });

  it("permite várias mensagens sem external_id", async () => {
    const { rows: empresa } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa sem external', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const { rows: lead } = await banco.db.query<{ id: string }>(
      `insert into leads (tenant_id, campaign_id, company_id, email)
       values ($1, $2, $3, 'semexternal@exemplo.com') returning id`,
      [banco.tenantId, banco.campaignId, empresa[0]!.id],
    );
    const inserir = (corpo: string) =>
      banco.db.query(
        `insert into messages (tenant_id, lead_id, direction, body)
         values ($1, $2, 'outbound', $3)`,
        [banco.tenantId, lead[0]!.id, corpo],
      );
    await inserir("primeira");
    await expect(inserir("segunda")).resolves.toBeDefined();
  });

  it("recusa um estágio de lead fora do enum", async () => {
    const { rows: empresa } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do enum', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    await expect(
      banco.db.query(
        `insert into leads (tenant_id, campaign_id, company_id, email, stage)
         values ($1, $2, $3, 'enum@exemplo.com', 'inventado')`,
        [banco.tenantId, banco.campaignId, empresa[0]!.id],
      ),
    ).rejects.toThrow();
  });
});
