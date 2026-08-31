import { describe, it, expect } from "vitest";
import {
  buscarEmpresaPorCnpj,
  normalizarCnpj,
} from "../../src/enrichment/brasilapi.js";
import { respostaJson, respostaVazia, fetchFalso } from "../helpers/http-mock.js";

const RESPOSTA_REAL = {
  cnpj: "11222333000181",
  razao_social: "ALFA ALIMENTOS LTDA",
  nome_fantasia: "ALFA ALIMENTOS",
  cnae_fiscal: 1091101,
  cnae_fiscal_descricao: "Fabricação de produtos de panificação industrial",
  uf: "SC",
  municipio: "JOINVILLE",
  porte: "DEMAIS",
  descricao_situacao_cadastral: "ATIVA",
  email: "diretoria@alfa.com.br",
  ddd_telefone_1: "4733334444",
  qsa: [
    {
      nome_socio: "MARIA SOUZA",
      qualificacao_socio: "Administrador",
      data_entrada_sociedade: "2010-03-01",
    },
    {
      nome_socio: "JOAO LIMA",
      qualificacao_socio: "Sócio-Administrador",
      data_entrada_sociedade: "2010-03-01",
    },
  ],
};

describe("normalizarCnpj", () => {
  it("remove pontuação", () => {
    expect(normalizarCnpj("11.222.333/0001-81")).toBe("11222333000181");
  });

  it("aceita um CNPJ já limpo", () => {
    expect(normalizarCnpj("11222333000181")).toBe("11222333000181");
  });

  it("recusa algo que não tem 14 dígitos", () => {
    expect(() => normalizarCnpj("123")).toThrow(/14 dígitos/);
  });
});

describe("buscarEmpresaPorCnpj", () => {
  it("traduz a resposta da API para o vocabulário do domínio", async () => {
    const fake = fetchFalso([respostaJson(RESPOSTA_REAL)]);
    const empresa = await buscarEmpresaPorCnpj("11.222.333/0001-81", {
      fetch: fake,
    });

    expect(empresa).toEqual({
      cnpj: "11222333000181",
      razaoSocial: "ALFA ALIMENTOS LTDA",
      nomeFantasia: "ALFA ALIMENTOS",
      cnaePrincipal: "1091101",
      descricaoCnae: "Fabricação de produtos de panificação industrial",
      uf: "SC",
      municipio: "JOINVILLE",
      porte: "DEMAIS",
      ativa: true,
      email: "diretoria@alfa.com.br",
      telefone: "4733334444",
      socios: [
        { nome: "MARIA SOUZA", qualificacao: "Administrador" },
        { nome: "JOAO LIMA", qualificacao: "Sócio-Administrador" },
      ],
    });
  });

  it("chama a URL certa com o CNPJ limpo", async () => {
    const fake = fetchFalso([respostaJson(RESPOSTA_REAL)]);
    await buscarEmpresaPorCnpj("11.222.333/0001-81", { fetch: fake });
    expect(fake.chamadas[0]).toBe(
      "https://brasilapi.com.br/api/cnpj/v1/11222333000181",
    );
  });

  it("marca como inativa quando a situação não é ATIVA", async () => {
    const fake = fetchFalso([
      respostaJson({ ...RESPOSTA_REAL, descricao_situacao_cadastral: "BAIXADA" }),
    ]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa?.ativa).toBe(false);
  });

  it("devolve null quando o CNPJ não existe", async () => {
    const fake = fetchFalso([respostaJson({ message: "não encontrado" }, 404)]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa).toBeNull();
  });

  it("propaga erro de servidor em vez de fingir que a empresa não existe", async () => {
    const fake = fetchFalso([respostaVazia(500), respostaVazia(500)]);
    await expect(
      buscarEmpresaPorCnpj("11222333000181", { fetch: fake }),
    ).rejects.toThrow();
  });

  it("lida com resposta sem sócios e sem e-mail", async () => {
    const fake = fetchFalso([
      respostaJson({ ...RESPOSTA_REAL, qsa: [], email: null, nome_fantasia: null }),
    ]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa?.socios).toEqual([]);
    expect(empresa?.email).toBeNull();
    expect(empresa?.nomeFantasia).toBeNull();
  });

  it("lida com qsa ausente do payload", async () => {
    const semQsa = { ...RESPOSTA_REAL } as Record<string, unknown>;
    delete semQsa.qsa;
    const fake = fetchFalso([respostaJson(semQsa)]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa?.socios).toEqual([]);
  });
});
