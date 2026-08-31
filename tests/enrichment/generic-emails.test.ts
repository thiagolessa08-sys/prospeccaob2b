import { describe, it, expect } from "vitest";
import { ehEmailGenerico } from "../../src/enrichment/generic-emails.js";

describe("ehEmailGenerico", () => {
  it("reconhece as caixas compartilhadas mais comuns no Brasil", () => {
    for (const email of [
      "contato@empresa.com.br",
      "comercial@empresa.com.br",
      "vendas@empresa.com.br",
      "sac@empresa.com.br",
      "atendimento@empresa.com.br",
      "financeiro@empresa.com.br",
      "rh@empresa.com.br",
      "faleconosco@empresa.com.br",
    ]) {
      expect(ehEmailGenerico(email), email).toBe(true);
    }
  });

  it("reconhece as caixas genéricas em inglês", () => {
    for (const email of [
      "info@empresa.com",
      "sales@empresa.com",
      "support@empresa.com",
      "admin@empresa.com",
      "hello@empresa.com",
      "noreply@empresa.com",
    ]) {
      expect(ehEmailGenerico(email), email).toBe(true);
    }
  });

  it("aceita e-mail de pessoa", () => {
    for (const email of [
      "maria.souza@empresa.com.br",
      "joao@empresa.com.br",
      "m.souza@empresa.com.br",
    ]) {
      expect(ehEmailGenerico(email), email).toBe(false);
    }
  });

  it("ignora maiúsculas e espaços", () => {
    expect(ehEmailGenerico("  Contato@Empresa.COM.BR ")).toBe(true);
  });

  it("não confunde um nome que começa igual a um prefixo genérico", () => {
    expect(ehEmailGenerico("contatore@empresa.com.br")).toBe(false);
    expect(ehEmailGenerico("informatica@empresa.com.br")).toBe(false);
  });

  it("trata e-mail malformado como genérico, por segurança", () => {
    expect(ehEmailGenerico("sem-arroba")).toBe(true);
  });
});
