import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import {
  carregarRegrasDeSupressao,
  adicionarSupressao,
} from "../../../src/db/repositories/suppression.js";
import { isSuppressed } from "../../../src/domain/suppression.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

describe("supressão", () => {
  it("começa vazia", async () => {
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toEqual([]);
  });

  it("grava e devolve uma regra de e-mail", async () => {
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "email", value: "chato@empresa.com" },
      "pedido de descadastro",
    );
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({
      kind: "email",
      value: "chato@empresa.com",
    });
  });

  it("grava e devolve uma regra de domínio", async () => {
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "domain", value: "concorrente.com.br" },
      "concorrente",
    );
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({
      kind: "domain",
      value: "concorrente.com.br",
    });
  });

  it("é idempotente: adicionar duas vezes não duplica nem lança", async () => {
    const regra = { kind: "email", value: "repetido@empresa.com" } as const;
    await adicionarSupressao(banco.db, banco.tenantId, regra, "primeiro");
    await adicionarSupressao(banco.db, banco.tenantId, regra, "segundo");
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    const iguais = regras.filter((r) => r.value === "repetido@empresa.com");
    expect(iguais).toHaveLength(1);
  });

  it("liga com a regra pura do domínio", async () => {
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(isSuppressed("qualquer@concorrente.com.br", regras)).toBe(true);
    expect(isSuppressed("alvo@empresa-nova.com.br", regras)).toBe(false);
  });
});
