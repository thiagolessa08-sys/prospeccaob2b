import { describe, it, expect } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const validSource = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  DATABASE_URL: "postgresql://x",
  HUNTER_API_KEY: "chave",
  CASA_DOS_DADOS_API_KEY: "chave-casa-dos-dados",
  INSTANTLY_API_KEY: "chave-instantly",
  INSTANTLY_CAMPAIGN_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  TENANT_ID: "11111111-1111-1111-1111-111111111111",
  INSTANTLY_WEBHOOK_SECRET: "segredo-instantly",
  CALCOM_WEBHOOK_SECRET: "segredo-calcom",
  N8N_SHARED_SECRET: "segredo-n8n",
  INSTANTLY_PREMISSA_VALIDADA_EM: "",
};

describe("loadEnv", () => {
  it("retorna as variáveis quando todas estão presentes", () => {
    expect(loadEnv(validSource)).toEqual(validSource);
  });

  it("lança erro nomeando a variável ausente", () => {
    const { DATABASE_URL, ...semBanco } = validSource;
    expect(() => loadEnv(semBanco)).toThrow(/DATABASE_URL/);
  });

  it("exige TENANT_ID em formato uuid, não só não-vazio", () => {
    // A coluna tenant_id é `uuid` no Postgres: um valor fora do formato passa
    // no boot e só explode na primeira consulta, como "invalid input syntax
    // for type uuid" — erro que aponta para o banco quando o problema é a
    // variável. Aconteceu em produção.
    expect(() =>
      loadEnv({ ...validSource, TENANT_ID: "uuid-do-tenant" }),
    ).toThrow(/TENANT_ID/);
  });

  it("lança erro quando uma variável está vazia", () => {
    expect(() => loadEnv({ ...validSource, ANTHROPIC_API_KEY: "" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
