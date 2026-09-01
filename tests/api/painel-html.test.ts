import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PAINEL_HTML } from "../../src/api/painel-html.js";

const FONTE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/api/painel-html.ts",
);

/**
 * Guarda de regressão para um bug que quebrou o build DUAS vezes.
 *
 * A tela inteira mora dentro de um template literal. Uma crase escrita num
 * comentário do JavaScript embutido — `carregar()`, do jeito que se escreve
 * código em prosa — fecha o template ali, e o resto do arquivo passa a ser
 * TypeScript inválido. O erro que o compilador reporta cai longe da causa, e
 * o deploy morre no build sem dizer o motivo real.
 *
 * Este teste lê o ARQUIVO-FONTE, não a constante: quando o bug acontece, o
 * módulo nem compila, mas a mensagem daqui aponta a linha certa.
 */
describe("o template da tela não pode ser fechado antes da hora", () => {
  it("não tem crase entre a abertura e o fechamento do template", () => {
    const fonte = readFileSync(FONTE, "utf8").split(/\r?\n/);

    const abertura = fonte.findIndex((l) => l.includes("PAINEL_HTML = `"));
    const fechamento = fonte.findIndex(
      (l, i) => i > abertura && l.trimEnd().endsWith("`;"),
    );

    expect(abertura).toBeGreaterThan(-1);
    expect(fechamento).toBeGreaterThan(abertura);

    const culpadas = fonte
      .slice(abertura + 1, fechamento)
      .map((linha, i) => ({ linha, numero: abertura + 2 + i }))
      .filter((l) => l.linha.includes("`"));

    expect(
      culpadas.map((c) => `linha ${c.numero}: ${c.linha.trim()}`),
    ).toEqual([]);
  });

  it("a constante chega inteira até o fim do documento", () => {
    // Se o template fechar cedo e ainda assim compilar, é aqui que aparece.
    expect(PAINEL_HTML).toContain("<!doctype html>");
    expect(PAINEL_HTML.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("tem os campos que o fluxo novo depende", () => {
    for (const id of ["f-proposito", "p-nicho", "p-cargos", "p-aprovar", "senha"]) {
      expect(PAINEL_HTML).toContain('id="' + id + '"');
    }
  });
});
