import { describe, it, expect } from "vitest";
import { alvoDaCampanha } from "../../src/enrichment/alvo.js";

describe("alvoDaCampanha", () => {
  it("reconhece sócio ou dono", () => {
    expect(alvoDaCampanha(["Sócio-Administrador"])).toEqual({
      tipo: "socio_ou_dono",
    });
  });

  it("reconhece proprietário", () => {
    expect(alvoDaCampanha(["Proprietário"])).toEqual({ tipo: "socio_ou_dono" });
  });

  it("mapeia Gerente de TI para o departamento it", () => {
    expect(alvoDaCampanha(["Gerente de TI"])).toEqual({
      tipo: "cargo_funcional",
      departamento: "it",
      cargos: ["Gerente de TI"],
    });
  });

  it("mapeia Diretor Financeiro para finance", () => {
    expect(alvoDaCampanha(["Diretor Financeiro"])).toEqual({
      tipo: "cargo_funcional",
      departamento: "finance",
      cargos: ["Diretor Financeiro"],
    });
  });

  it("mapeia Gerente Comercial para sales", () => {
    expect(alvoDaCampanha(["Gerente Comercial"])).toEqual({
      tipo: "cargo_funcional",
      departamento: "sales",
      cargos: ["Gerente Comercial"],
    });
  });

  it("usa o primeiro cargo que casar quando há vários", () => {
    const resultado = alvoDaCampanha(["Assistente", "Gerente de TI"]);
    expect(resultado).toEqual({
      tipo: "cargo_funcional",
      departamento: "it",
      cargos: ["Assistente", "Gerente de TI"],
    });
  });

  it("cai para sócio ou dono quando nada bate com um departamento conhecido", () => {
    expect(alvoDaCampanha(["Coordenador de Qualidade"])).toEqual({
      tipo: "socio_ou_dono",
    });
  });

  it("cai para sócio ou dono com lista vazia", () => {
    expect(alvoDaCampanha([])).toEqual({ tipo: "socio_ou_dono" });
  });

  it("ignora maiúsculas e acentos na comparação", () => {
    expect(alvoDaCampanha(["GERENTE DE TECNOLOGIA"])).toEqual({
      tipo: "cargo_funcional",
      departamento: "it",
      cargos: ["GERENTE DE TECNOLOGIA"],
    });
  });
});
