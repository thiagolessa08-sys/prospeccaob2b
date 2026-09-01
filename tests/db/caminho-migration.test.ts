import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import { CAMINHO_DAS_MIGRATIONS } from "../../src/db/caminho-migration.js";
import { listarMigrations } from "../../src/db/migrations.js";

/**
 * Guarda de regressão para um bug que foi ao ar: o script de migration nasceu
 * em `scripts/` (onde `../supabase` era o certo), foi movido para `src/db/`, e
 * o caminho relativo não acompanhou. O deploy no Railway entrou em loop de
 * crash procurando `/app/dist/supabase/...`.
 *
 * O teste roda a partir de `src/db/`, que está à mesma profundidade de
 * `dist/db/` — então acertar aqui é acertar no artefato compilado também.
 */
describe("CAMINHO_DAS_MIGRATIONS", () => {
  it("aponta para um diretório que existe", () => {
    expect(existsSync(CAMINHO_DAS_MIGRATIONS)).toBe(true);
    expect(statSync(CAMINHO_DAS_MIGRATIONS).isDirectory()).toBe(true);
  });

  it("resolve para fora de src/ e de dist/", () => {
    const normalizado = CAMINHO_DAS_MIGRATIONS.replace(/\\/g, "/");
    expect(normalizado).toContain("/supabase/migrations");
    expect(normalizado).not.toContain("/src/supabase/");
    expect(normalizado).not.toContain("/dist/supabase/");
  });

  it("contém o schema inicial, e não outro .sql qualquer", () => {
    const migrations = listarMigrations(CAMINHO_DAS_MIGRATIONS);
    expect(migrations.length).toBeGreaterThan(0);

    const primeira = migrations[0]!;
    expect(primeira.versao).toBe("0001_initial_schema.sql");
    expect(primeira.sql).toContain("create table tenants");
    expect(primeira.sql).toContain("create table campaigns");
    expect(primeira.sql).toContain("create table leads");
  });

  it("todas as migrations do repositório seguem a convenção de nome", () => {
    // `listarMigrations` lança em arquivo fora do padrão. Chamar aqui é o que
    // impede alguém de acrescentar `nova.sql` sem prefixo e só descobrir no
    // deploy, onde a ordem de aplicação passaria a ser indefinida.
    expect(() => listarMigrations(CAMINHO_DAS_MIGRATIONS)).not.toThrow();
  });
});
