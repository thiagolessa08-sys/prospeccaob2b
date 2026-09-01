import { describe, it, expect } from "vitest";
import { dominioDoSite } from "../../src/enrichment/dominio.js";

describe("dominioDoSite", () => {
  it("extrai o domínio de uma URL completa", () => {
    expect(dominioDoSite("https://www.alfa.com.br/sobre")).toBe("alfa.com.br");
  });

  it("aceita um domínio sem protocolo", () => {
    expect(dominioDoSite("alfa.com.br")).toBe("alfa.com.br");
  });

  it("remove o www mesmo sem protocolo", () => {
    expect(dominioDoSite("www.alfa.com.br")).toBe("alfa.com.br");
  });

  it("devolve null para site nulo", () => {
    expect(dominioDoSite(null)).toBeNull();
  });

  it("devolve null para string vazia", () => {
    expect(dominioDoSite("   ")).toBeNull();
  });

  it("devolve null para URL malformada, em vez de lançar", () => {
    expect(dominioDoSite("http://")).toBeNull();
  });
});
