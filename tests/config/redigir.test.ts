import { describe, it, expect } from "vitest";
import { semSegredos } from "../../src/config/redigir.js";

const AMBIENTE = {
  DATABASE_URL: "postgresql://postgres:SenhaSuperSecreta@host.interno:5432/railway",
  ANTHROPIC_API_KEY: "sk-ant-chave-muito-secreta-aqui",
  N8N_SHARED_SECRET: "segredo-do-n8n-bem-longo",
  TENANT_ID: "11111111-1111-1111-1111-111111111111",
} as NodeJS.ProcessEnv;

describe("semSegredos", () => {
  it("redige a connection string inteira", () => {
    const erro = `connect ECONNREFUSED using ${AMBIENTE.DATABASE_URL}`;
    const limpo = semSegredos(erro, AMBIENTE);
    expect(limpo).not.toContain("SenhaSuperSecreta");
    expect(limpo).toContain("[DATABASE_URL]");
  });

  it("redige a senha sozinha, sem o resto da URL", () => {
    // O driver às vezes cita só a senha, sem a connection string completa.
    const limpo = semSegredos('password "SenhaSuperSecreta" rejeitada', AMBIENTE);
    expect(limpo).not.toContain("SenhaSuperSecreta");
    expect(limpo).toContain("***");
  });

  it("redige chaves de API de fornecedores", () => {
    const limpo = semSegredos(
      `401 para ${AMBIENTE.ANTHROPIC_API_KEY} e ${AMBIENTE.N8N_SHARED_SECRET}`,
      AMBIENTE,
    );
    expect(limpo).not.toContain("sk-ant-chave-muito-secreta-aqui");
    expect(limpo).not.toContain("segredo-do-n8n-bem-longo");
    expect(limpo).toContain("[ANTHROPIC_API_KEY]");
    expect(limpo).toContain("[N8N_SHARED_SECRET]");
  });

  it("não mexe em texto sem segredo", () => {
    const erro = 'relation "campaigns" does not exist';
    expect(semSegredos(erro, AMBIENTE)).toBe(erro);
  });

  it("ignora variável que não é segredo, como TENANT_ID", () => {
    // Redigir o tenant tornaria todo log inútil para depurar — e ele não é
    // credencial: aparece em URL e em corpo de webhook o tempo todo.
    const erro = `lead do tenant ${AMBIENTE.TENANT_ID} não encontrado`;
    expect(semSegredos(erro, AMBIENTE)).toContain(AMBIENTE.TENANT_ID!);
  });

  it("ignora valor curto demais para ser segredo", () => {
    // Sem o piso de tamanho, um valor de 2 letras picotaria o texto inteiro.
    const limpo = semSegredos("erro ao ler ab", { ANTHROPIC_API_KEY: "ab" });
    expect(limpo).toBe("erro ao ler ab");
  });

  it("aguenta DATABASE_URL malformada sem lançar", () => {
    const limpo = semSegredos("qualquer erro", { DATABASE_URL: "nao-e-url" });
    expect(limpo).toBe("qualquer erro");
  });
});
