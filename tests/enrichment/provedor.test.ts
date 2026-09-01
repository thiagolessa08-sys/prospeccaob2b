import { describe, it, expect } from "vitest";
import { escolherProvedor } from "../../src/enrichment/provedor.js";
import { briefingEmTexto } from "../../src/ai/email-writer.js";

describe("escolherProvedor", () => {
  it("usa a Hunter quando não há chave da Lusha", () => {
    // O padrão tem que ser este: quem já está rodando não pode mudar de
    // fornecedor por causa de um deploy.
    const p = escolherProvedor({ hunter: "chave-hunter", lusha: "" });
    expect(p.nome).toBe("hunter");
    expect(p.apiKey).toBe("chave-hunter");
  });

  it("usa a Lusha quando a chave dela está preenchida", () => {
    const p = escolherProvedor({ hunter: "chave-hunter", lusha: "chave-lusha" });
    expect(p.nome).toBe("lusha");
    expect(p.apiKey).toBe("chave-lusha");
  });

  it("ignora chave da Lusha só com espaços", () => {
    const p = escolherProvedor({ hunter: "chave-hunter", lusha: "   " });
    expect(p.nome).toBe("hunter");
  });

  it("a chave que sai é sempre a do provedor escolhido", () => {
    // A cadeia leva UMA chave. Devolver a do outro fornecedor mandaria a
    // credencial da Hunter para o endpoint da Lusha — 401 em toda empresa.
    const lusha = escolherProvedor({ hunter: "h", lusha: "l" });
    expect(lusha.apiKey).not.toBe("h");

    const hunter = escolherProvedor({ hunter: "h", lusha: "" });
    expect(hunter.apiKey).not.toBe("l");
  });

  it("a descoberta de empresa continua na Receita nos dois casos", () => {
    // A Lusha substitui só quem acha o decisor. `buscarEmpresa` é o CNPJ, que
    // traz situação cadastral — o que evita gastar crédito com empresa baixada.
    const lusha = escolherProvedor({ hunter: "h", lusha: "l" });
    const hunter = escolherProvedor({ hunter: "h", lusha: "" });
    expect(lusha.deps.buscarEmpresa).toBe(hunter.deps.buscarEmpresa);
  });
});

describe("briefingEmTexto", () => {
  it("devolve vazio quando não há briefing", () => {
    expect(briefingEmTexto(null)).toBe("");
    expect(briefingEmTexto(undefined)).toBe("");
    expect(briefingEmTexto("não é objeto")).toBe("");
  });

  it("omite a seção cuja lista está vazia", () => {
    // Um cabeçalho com lista vazia embaixo seria lido pelo modelo como "não
    // há dor nenhuma a citar", que é diferente de "não foi informado".
    const texto = briefingEmTexto({ angulo: "o fechamento consome a equipe", dores: [] });
    expect(texto).toContain("Ângulo da abordagem:");
    expect(texto).not.toContain("Dores");
  });

  it("monta as seções que vieram", () => {
    const texto = briefingEmTexto({
      angulo: "ângulo",
      dores: ["planilha que ninguém confia"],
      provas: ["caso X"],
      evitar: ["prometer prazo"],
    });
    expect(texto).toContain("- planilha que ninguém confia");
    expect(texto).toContain("- caso X");
    expect(texto).toContain("Não diga, nesta campanha:");
  });

  it("aguenta o que vier de uma coluna jsonb sem validação", () => {
    // Isto chega de `campaigns.pitch_briefing` cru. Um número no lugar da
    // lista não pode derrubar o envio do lote inteiro.
    expect(() =>
      briefingEmTexto({ angulo: 42, dores: "não é lista", provas: [1, 2], evitar: null }),
    ).not.toThrow();
    expect(briefingEmTexto({ dores: [null, "", "  ", "válida"] })).toContain("- válida");
  });
});

describe("descreverProvedor", () => {
  it("avisa quando cai na Hunter sem chave", async () => {
    // O caso que custou 20 empresas: HUNTER_API_KEY no placeholder, LUSHA
    // vazia, e toda empresa falhando com 401 disfarçado de "nenhum decisor
    // encontrado". A etiqueta precisa dizer isso antes de alguém clicar.
    const { descreverProvedor } = await import("../../src/enrichment/provedor.js");
    expect(descreverProvedor({ hunter: "", lusha: "" })).toContain("SEM CHAVE");
  });

  it("nomeia o fornecedor configurado, sem alarme", async () => {
    const { descreverProvedor } = await import("../../src/enrichment/provedor.js");
    expect(descreverProvedor({ hunter: "", lusha: "chave-lusha" })).toBe("lusha");
    expect(descreverProvedor({ hunter: "chave-hunter", lusha: "" })).toBe("hunter");
  });
});
