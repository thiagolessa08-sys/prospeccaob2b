import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  extractDomain,
  isSuppressed,
  ruleForOptOut,
  type SuppressionRule,
} from "../../src/domain/suppression.js";

describe("normalizeEmail", () => {
  it("converte para minúsculas e remove espaços nas pontas", () => {
    expect(normalizeEmail("  Joao.Silva@Empresa.COM.BR ")).toBe(
      "joao.silva@empresa.com.br",
    );
  });

  it("lança erro em endereço sem arroba", () => {
    expect(() => normalizeEmail("nao-e-email")).toThrow(/inválido/);
  });

  it("lança erro em endereço vazio", () => {
    expect(() => normalizeEmail("   ")).toThrow(/inválido/);
  });
});

describe("extractDomain", () => {
  it("extrai o domínio normalizado", () => {
    expect(extractDomain("Joao@Empresa.com.BR")).toBe("empresa.com.br");
  });

  it("usa o último arroba em endereços com mais de um", () => {
    expect(extractDomain("estranho@interno@empresa.com")).toBe("empresa.com");
  });
});

describe("isSuppressed", () => {
  const regras: SuppressionRule[] = [
    { kind: "email", value: "chato@empresa.com" },
    { kind: "domain", value: "concorrente.com.br" },
  ];

  it("bloqueia e-mail que consta na lista", () => {
    expect(isSuppressed("chato@empresa.com", regras)).toBe(true);
  });

  it("bloqueia ignorando maiúsculas e espaços", () => {
    expect(isSuppressed("  CHATO@Empresa.com ", regras)).toBe(true);
  });

  it("bloqueia qualquer endereço de domínio suprimido", () => {
    expect(isSuppressed("qualquer.um@concorrente.com.br", regras)).toBe(true);
  });

  it("libera endereço que não consta na lista", () => {
    expect(isSuppressed("novo@empresa.com", regras)).toBe(false);
  });

  it("não confunde sufixo de domínio com domínio suprimido", () => {
    expect(isSuppressed("alvo@naoconcorrente.com.br", regras)).toBe(false);
  });

  it("libera qualquer endereço quando a lista está vazia", () => {
    expect(isSuppressed("alguem@empresa.com", [])).toBe(false);
  });

  it("trata e-mail malformado como suprimido, por segurança", () => {
    expect(isSuppressed("sem-arroba", regras)).toBe(true);
  });
});

describe("ruleForOptOut", () => {
  it("gera regra de e-mail normalizada", () => {
    expect(ruleForOptOut(" Pessoa@Empresa.COM ")).toEqual({
      kind: "email",
      value: "pessoa@empresa.com",
    });
  });
});
