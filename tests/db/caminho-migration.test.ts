import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { CAMINHO_DA_MIGRATION } from "../../src/db/caminho-migration.js";

/**
 * Guarda de regressão para um bug que foi ao ar: o script de migration nasceu
 * em `scripts/` (onde `../supabase` era o certo), foi movido para `src/db/`, e
 * o caminho relativo não acompanhou. O deploy no Railway entrou em loop de
 * crash procurando `/app/dist/supabase/...`.
 *
 * O teste roda a partir de `src/db/`, que está à mesma profundidade de
 * `dist/db/` — então acertar aqui é acertar no artefato compilado também.
 */
describe("CAMINHO_DA_MIGRATION", () => {
  it("aponta para um arquivo que existe", () => {
    expect(existsSync(CAMINHO_DA_MIGRATION)).toBe(true);
  });

  it("aponta para o schema, e não para outro .sql qualquer", () => {
    const sql = readFileSync(CAMINHO_DA_MIGRATION, "utf8");
    expect(sql).toContain("create table tenants");
    expect(sql).toContain("create table campaigns");
    expect(sql).toContain("create table leads");
  });

  it("resolve para fora de src/ e de dist/", () => {
    const normalizado = CAMINHO_DA_MIGRATION.replace(/\\/g, "/");
    expect(normalizado).toContain("/supabase/migrations/");
    expect(normalizado).not.toContain("/src/supabase/");
    expect(normalizado).not.toContain("/dist/supabase/");
  });
});
