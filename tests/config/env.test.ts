import { describe, it, expect } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const validSource = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "chave-de-servico",
};

describe("loadEnv", () => {
  it("retorna as variáveis quando todas estão presentes", () => {
    expect(loadEnv(validSource)).toEqual(validSource);
  });

  it("lança erro nomeando a variável ausente", () => {
    const { SUPABASE_URL, ...semUrl } = validSource;
    expect(() => loadEnv(semUrl)).toThrow(/SUPABASE_URL/);
  });

  it("lança erro quando SUPABASE_URL não é uma URL", () => {
    expect(() =>
      loadEnv({ ...validSource, SUPABASE_URL: "abc.supabase.co" }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("lança erro quando uma variável está vazia", () => {
    expect(() => loadEnv({ ...validSource, ANTHROPIC_API_KEY: "" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
