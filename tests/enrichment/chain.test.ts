import { describe, it, expect, vi } from "vitest";
import {
  enriquecerDecisor,
  type DepsEnriquecimento,
} from "../../src/enrichment/chain.js";
import type { DadosDaEmpresa } from "../../src/enrichment/types.js";

const EMPRESA: DadosDaEmpresa = {
  cnpj: "11222333000181",
  razaoSocial: "ALFA ALIMENTOS LTDA",
  nomeFantasia: "ALFA ALIMENTOS",
  cnaePrincipal: "1091101",
  descricaoCnae: "Panificação industrial",
  uf: "SC",
  municipio: "JOINVILLE",
  porte: "DEMAIS",
  ativa: true,
  email: null,
  telefone: "4733334444",
  socios: [{ nome: "MARIA SOUZA", qualificacao: "Administrador" }],
};

function deps(overrides: Partial<DepsEnriquecimento> = {}): DepsEnriquecimento {
  return {
    buscarEmpresa: vi.fn().mockResolvedValue(EMPRESA),
    acharPorNome: vi.fn().mockResolvedValue(null),
    buscarDominio: vi.fn().mockResolvedValue([]),
    verificar: vi.fn().mockResolvedValue({ status: "valid", score: 90 }),
    ...overrides,
  };
}

const ENTRADA = {
  cnpj: "11222333000181",
  dominio: "alfa.com.br",
  apiKey: "chave",
  alvo: { tipo: "socio_ou_dono" } as const,
};

describe("enriquecerDecisor — caminho grátis", () => {
  it("usa o e-mail do registro da Receita quando ele é de pessoa", async () => {
    const d = deps({
      buscarEmpresa: vi
        .fn()
        .mockResolvedValue({ ...EMPRESA, email: "maria.souza@alfa.com.br" }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.achou).toBe(true);
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.email).toBe("maria.souza@alfa.com.br");
    expect(r.candidato.fonte).toBe("cnpj_email");
    expect(d.acharPorNome).not.toHaveBeenCalled();
  });

  it("rejeita o e-mail da Receita quando é caixa genérica e segue a cadeia", async () => {
    const d = deps({
      buscarEmpresa: vi
        .fn()
        .mockResolvedValue({ ...EMPRESA, email: "contato@alfa.com.br" }),
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: "Administradora",
        email: "maria@alfa.com.br",
        confianca: 90,
        verificacao: "valid",
        fonte: "hunter_finder",
      }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.achou).toBe(true);
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.fonte).toBe("hunter_finder");
    expect(r.tentativas.map((t) => t.resultado)).toContain("generico");
  });
});

describe("enriquecerDecisor — caminho pago", () => {
  it("usa o nome do sócio para chamar o email-finder, em vez de buscar às cegas", async () => {
    const acharPorNome = vi.fn().mockResolvedValue({
      nome: "Maria Souza",
      cargo: null,
      email: "maria.souza@alfa.com.br",
      confianca: 88,
      verificacao: "valid",
      fonte: "hunter_finder",
    });
    const d = deps({ acharPorNome });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(acharPorNome).toHaveBeenCalledWith(
      expect.objectContaining({
        dominio: "alfa.com.br",
        primeiroNome: "MARIA",
        sobrenome: "SOUZA",
      }),
    );
    expect(r.achou).toBe(true);
  });

  it("cai para a busca por domínio quando o cargo-alvo é funcional", async () => {
    const buscarDominio = vi.fn().mockResolvedValue([
      {
        nome: "João Lima",
        cargo: "Gerente de TI",
        email: "joao@alfa.com.br",
        confianca: 85,
        verificacao: "valid",
        fonte: "hunter_domain",
      },
    ]);
    const d = deps({ buscarDominio });
    const r = await enriquecerDecisor(
      { ...ENTRADA, alvo: { tipo: "cargo_funcional", departamento: "it", cargos: ["Gerente de TI"] } },
      d,
    );

    expect(buscarDominio).toHaveBeenCalledWith(
      expect.objectContaining({ dominio: "alfa.com.br", departamento: "it" }),
    );
    expect(r.achou).toBe(true);
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.fonte).toBe("hunter_domain");
  });

  it("descarta candidatos genéricos vindos da busca por domínio", async () => {
    const buscarDominio = vi.fn().mockResolvedValue([
      {
        nome: null,
        cargo: null,
        email: "contato@alfa.com.br",
        confianca: 99,
        verificacao: "valid",
        fonte: "hunter_domain",
      },
    ]);
    const d = deps({ buscarDominio });
    const r = await enriquecerDecisor(
      { ...ENTRADA, alvo: { tipo: "cargo_funcional", departamento: "it", cargos: ["Gerente de TI"] } },
      d,
    );

    expect(r.achou).toBe(false);
    expect(r.tentativas.some((t) => t.resultado === "generico")).toBe(true);
  });

  it("escolhe o candidato de maior confiança quando há vários", async () => {
    const buscarDominio = vi.fn().mockResolvedValue([
      { nome: "A", cargo: null, email: "a@alfa.com.br", confianca: 60, verificacao: "valid", fonte: "hunter_domain" },
      { nome: "B", cargo: null, email: "b@alfa.com.br", confianca: 92, verificacao: "valid", fonte: "hunter_domain" },
    ]);
    const d = deps({ buscarDominio });
    const r = await enriquecerDecisor(
      { ...ENTRADA, alvo: { tipo: "cargo_funcional", departamento: "it", cargos: ["Gerente de TI"] } },
      d,
    );
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.email).toBe("b@alfa.com.br");
  });
});

describe("enriquecerDecisor — recusas", () => {
  it("recusa empresa inativa antes de gastar qualquer crédito", async () => {
    const d = deps({
      buscarEmpresa: vi.fn().mockResolvedValue({ ...EMPRESA, ativa: false }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.achou).toBe(false);
    if (r.achou) throw new Error("esperava falha");
    expect(r.motivo).toMatch(/inativa/i);
    expect(d.acharPorNome).not.toHaveBeenCalled();
    expect(d.buscarDominio).not.toHaveBeenCalled();
  });

  it("recusa quando o CNPJ não existe", async () => {
    const d = deps({ buscarEmpresa: vi.fn().mockResolvedValue(null) });
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(false);
    if (r.achou) throw new Error("esperava falha");
    expect(r.motivo).toMatch(/não encontrada/i);
  });

  it("recusa um e-mail que a verificação reprovou", async () => {
    const d = deps({
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria@alfa.com.br",
        confianca: 80,
        verificacao: "invalid",
        fonte: "hunter_finder",
      }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(false);
    expect(r.tentativas.some((t) => t.resultado === "nao_verificado")).toBe(true);
  });

  it("aceita accept_all, que é indeterminado e não reprovado", async () => {
    const d = deps({
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria@alfa.com.br",
        confianca: 80,
        verificacao: "accept_all",
        fonte: "hunter_finder",
      }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(true);
  });

  it("chama a verificação paga quando a Hunter devolve status desconhecido", async () => {
    // O ramo que gasta crédito. Até aqui só o caminho `cnpj_email` chegava
    // nele, porque é o único que nasce com `verificacao: "unknown"` — mas a
    // Hunter também pode devolver um status que não sabemos traduzir, e nesse
    // caso o /email-verifier precisa mesmo ser chamado.
    const verificar = vi
      .fn()
      .mockResolvedValue({ status: "valid", score: 85 });
    const d = deps({
      verificar,
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria@alfa.com.br",
        confianca: 80,
        verificacao: "unknown",
        fonte: "hunter_finder",
      }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(verificar).toHaveBeenCalledWith({
      email: "maria@alfa.com.br",
      apiKey: "chave",
    });
    expect(r.achou).toBe(true);
    if (!r.achou) throw new Error("esperava sucesso");
    // O status que vale é o que a verificação devolveu, não o "unknown" que
    // veio da fonte.
    expect(r.candidato.verificacao).toBe("valid");
  });

  it("registra a falha da fonte e continua, em vez de derrubar a cadeia", async () => {
    const d = deps({
      acharPorNome: vi.fn().mockRejectedValue(new Error("Hunter fora do ar")),
      buscarDominio: vi.fn().mockResolvedValue([
        { nome: "C", cargo: null, email: "c@alfa.com.br", confianca: 70, verificacao: "valid", fonte: "hunter_domain" },
      ]),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.tentativas.some((t) => t.resultado === "erro")).toBe(true);
    expect(r.achou).toBe(true);
  });

  it("devolve todas as tentativas mesmo quando nada é achado", async () => {
    const d = deps();
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(false);
    expect(r.tentativas.length).toBeGreaterThan(0);
    for (const t of r.tentativas) {
      expect(t).toHaveProperty("fonte");
      expect(t).toHaveProperty("resultado");
    }
  });
});

/**
 * Esta bateria cobre o buraco que derrubou o funil no smoke de ponta a ponta:
 * a busca avançada da Casa dos Dados não devolve site nenhum, então TODA
 * empresa descoberta chega aqui com `dominio: null`. Antes da correção a
 * cadeia desistia na hora, e o enriquecimento tinha 100% de falha em produção
 * — invisível nos testes, porque as fixturas traziam domínio embutido.
 */
describe("enriquecerDecisor — empresa sem domínio", () => {
  const SEM_DOMINIO = { ...ENTRADA, dominio: null };

  it("deriva o domínio do e-mail que a empresa declarou à Receita", async () => {
    const d = deps({
      buscarEmpresa: vi
        .fn()
        .mockResolvedValue({ ...EMPRESA, email: "contato@alfa.com.br" }),
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria.souza@alfa.com.br",
        confianca: 90,
        verificacao: "valid",
        fonte: "hunter_finder",
      }),
    });

    const r = await enriquecerDecisor(SEM_DOMINIO, d);

    expect(r.achou).toBe(true);
    // Caixa genérica não serve como destinatário, mas o domínio dela sim.
    expect(d.acharPorNome).toHaveBeenCalledWith(
      expect.objectContaining({ dominio: "alfa.com.br" }),
    );
  });

  it("cai para o nome da empresa quando não há site nem e-mail na Receita", async () => {
    const d = deps({
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria.souza@alfa.com.br",
        confianca: 90,
        verificacao: "valid",
        fonte: "hunter_finder",
      }),
    });

    const r = await enriquecerDecisor(SEM_DOMINIO, d);

    expect(r.achou).toBe(true);
    // A Hunter aceita `company` no lugar de `domain` — sem isso, o CNPJ
    // descoberto seria descartado sem nenhuma tentativa.
    expect(d.acharPorNome).toHaveBeenCalledWith(
      expect.objectContaining({ empresa: "ALFA ALIMENTOS" }),
    );
    expect(d.acharPorNome).toHaveBeenCalledWith(
      expect.not.objectContaining({ dominio: expect.anything() }),
    );
  });

  it("usa o nome da empresa também na busca por cargo funcional", async () => {
    const d = deps({
      buscarDominio: vi.fn().mockResolvedValue([
        {
          nome: "Joao Lima",
          cargo: "Gerente de TI",
          email: "joao.lima@alfa.com.br",
          confianca: 88,
          verificacao: "valid",
          fonte: "hunter_domain",
        },
      ]),
    });

    const r = await enriquecerDecisor(
      { ...SEM_DOMINIO, alvo: { tipo: "cargo_funcional", departamento: "it", cargos: ["Gerente de TI"] } },
      d,
    );

    expect(r.achou).toBe(true);
    expect(d.buscarDominio).toHaveBeenCalledWith(
      expect.objectContaining({ empresa: "ALFA ALIMENTOS", departamento: "it" }),
    );
  });

  it("prefere a razão social quando não há nome fantasia", async () => {
    const d = deps({
      buscarEmpresa: vi
        .fn()
        .mockResolvedValue({ ...EMPRESA, nomeFantasia: null }),
    });

    await enriquecerDecisor(SEM_DOMINIO, d);

    expect(d.acharPorNome).toHaveBeenCalledWith(
      expect.objectContaining({ empresa: "ALFA ALIMENTOS LTDA" }),
    );
  });

  it("não deriva domínio de provedor pessoal: cai para o nome da empresa", async () => {
    // Caixa genérica (descartada como destinatário) e ainda por cima num
    // provedor pessoal — "gmail.com" não é o domínio da empresa, e procurar
    // decisores nele não significaria nada.
    const d = deps({
      buscarEmpresa: vi
        .fn()
        .mockResolvedValue({ ...EMPRESA, email: "contato@gmail.com" }),
    });

    await enriquecerDecisor(SEM_DOMINIO, d);

    expect(d.acharPorNome).toHaveBeenCalledWith(
      expect.objectContaining({ empresa: "ALFA ALIMENTOS" }),
    );
    expect(d.acharPorNome).not.toHaveBeenCalledWith(
      expect.objectContaining({ dominio: "gmail.com" }),
    );
  });
});
