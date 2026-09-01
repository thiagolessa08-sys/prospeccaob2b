import { describe, it, expect } from "vitest";
import { dominioDoSite, dominioDoEmail } from "../../src/enrichment/dominio.js";

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

describe("dominioDoEmail", () => {
  it("extrai o domínio corporativo", () => {
    expect(dominioDoEmail("maria.souza@empresa.com.br")).toBe("empresa.com.br");
  });

  it("aproveita o domínio mesmo de caixa genérica", () => {
    // O endereço não presta como destinatário, mas o domínio é o que a Hunter
    // precisa — é justamente o que salva a empresa sem site cadastrado.
    expect(dominioDoEmail("contato@empresa.com.br")).toBe("empresa.com.br");
  });

  it("normaliza caixa alta e espaços", () => {
    expect(dominioDoEmail("  Contato@Empresa.COM.BR ")).toBe("empresa.com.br");
  });

  it("devolve null para provedor pessoal, que não é o domínio da empresa", () => {
    expect(dominioDoEmail("dono.da.empresa@gmail.com")).toBeNull();
    expect(dominioDoEmail("contato@hotmail.com")).toBeNull();
    expect(dominioDoEmail("vendas@uol.com.br")).toBeNull();
  });

  it("devolve null para nulo, vazio ou malformado", () => {
    expect(dominioDoEmail(null)).toBeNull();
    expect(dominioDoEmail("   ")).toBeNull();
    expect(dominioDoEmail("sem-arroba")).toBeNull();
    expect(dominioDoEmail("@semlocal.com")).toBeNull();
    expect(dominioDoEmail("sem-dominio@")).toBeNull();
    expect(dominioDoEmail("sem-ponto@dominio")).toBeNull();
  });
});
