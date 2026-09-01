import { describe, it, expect } from "vitest";
import {
  COOKIE_DO_PAINEL,
  criarSessao,
  sessaoConfere,
  cabecalhoDeSessao,
  cabecalhoDeSaida,
} from "../../src/api/sessao-painel.js";

const SENHA = "senha-longa-do-operador";

function comoCookie(valor: string): string {
  return COOKIE_DO_PAINEL + "=" + valor;
}

describe("sessaoConfere", () => {
  it("aceita a sessão que acabou de emitir", () => {
    expect(sessaoConfere(comoCookie(criarSessao(SENHA)), SENHA)).toBe(true);
  });

  it("recusa depois de expirada", () => {
    const emitida = criarSessao(SENHA, 0);
    // Doze horas e um minuto depois.
    expect(sessaoConfere(comoCookie(emitida), SENHA, 12 * 3600_000 + 60_000)).toBe(false);
  });

  it("recusa assinatura adulterada", () => {
    const valor = criarSessao(SENHA);
    const ponto = valor.indexOf(".");
    const adulterada = valor.slice(0, ponto + 1) + "0".repeat(64);
    expect(sessaoConfere(comoCookie(adulterada), SENHA)).toBe(false);
  });

  it("recusa validade esticada sem reassinar", () => {
    // O ataque óbvio: pegar o cookie e empurrar a data para frente. A
    // assinatura cobre justamente esse número, então deixa de bater.
    const valor = criarSessao(SENHA, 0);
    const assinatura = valor.slice(valor.indexOf(".") + 1);
    const esticada = 99999999999999 + "." + assinatura;
    expect(sessaoConfere(comoCookie(esticada), SENHA)).toBe(false);
  });

  it("recusa sessão emitida com outra senha", () => {
    const deOutro = criarSessao("outra-senha-qualquer");
    expect(sessaoConfere(comoCookie(deOutro), SENHA)).toBe(false);
  });

  it("recusa sempre quando não há senha configurada", () => {
    // Sem chave, a verificação viraria formalidade que aprova qualquer um —
    // e abriria o painel a quem descobrisse a URL.
    const valor = criarSessao("");
    expect(sessaoConfere(comoCookie(valor), "")).toBe(false);
  });

  it("recusa cookie ausente, vazio ou malformado", () => {
    expect(sessaoConfere(null, SENHA)).toBe(false);
    expect(sessaoConfere("", SENHA)).toBe(false);
    expect(sessaoConfere("outro=coisa", SENHA)).toBe(false);
    expect(sessaoConfere(comoCookie("sem-ponto"), SENHA)).toBe(false);
    expect(sessaoConfere(comoCookie(".semvalidade"), SENHA)).toBe(false);
    expect(sessaoConfere(comoCookie("abc.def"), SENHA)).toBe(false);
  });

  it("acha o cookie no meio de outros", () => {
    const header = "ga=1; " + comoCookie(criarSessao(SENHA)) + "; tema=escuro";
    expect(sessaoConfere(header, SENHA)).toBe(true);
  });
});

describe("cabeçalhos do cookie", () => {
  it("emite HttpOnly, Secure e SameSite=Strict", () => {
    const header = cabecalhoDeSessao(criarSessao(SENHA));
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
  });

  it("a saída zera a validade, mantendo os mesmos atributos", () => {
    // O navegador só apaga o cookie cujo nome, caminho e atributos casam.
    const header = cabecalhoDeSaida();
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
  });
});
