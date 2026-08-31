import { describe, it, expect } from "vitest";
import { paraNovoLead } from "../../src/enrichment/para-lead.js";
import type { CandidatoDecisor } from "../../src/enrichment/types.js";

const IDS = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  campaignId: "22222222-2222-2222-2222-222222222222",
  companyId: "33333333-3333-3333-3333-333333333333",
};

function candidato(
  overrides: Partial<CandidatoDecisor> = {},
): CandidatoDecisor {
  return {
    nome: "Maria Souza",
    cargo: "Administradora",
    email: "maria@alfa.com.br",
    confianca: 88,
    verificacao: "valid",
    fonte: "hunter_finder",
    ...overrides,
  };
}

describe("paraNovoLead", () => {
  it("renomeia os campos e carrega os três ids que a cadeia nunca vê", () => {
    const lead = paraNovoLead(candidato(), IDS);

    expect(lead).toEqual({
      ...IDS,
      fullName: "Maria Souza",
      roleTitle: "Administradora",
      email: "maria@alfa.com.br",
      emailVerified: true,
    });
  });

  it("preserva nome e cargo nulos, em vez de inventar valor", () => {
    const lead = paraNovoLead(candidato({ nome: null, cargo: null }), IDS);
    expect(lead.fullName).toBeNull();
    expect(lead.roleTitle).toBeNull();
  });

  it("não marca accept_all como verificado: indeterminado não entra na fila", () => {
    const lead = paraNovoLead(candidato({ verificacao: "accept_all" }), IDS);

    // A cadeia aceita accept_all como candidato — o domínio aceita tudo, o que
    // é indeterminação e não reprovação. Mas `listarProntosParaContato` filtra
    // por `email_verified = true`, e um accept_all é o endereço com maior
    // chance de voltar como bounce: ele não pode entrar na fila de envio.
    expect(lead.emailVerified).toBe(false);
  });

  it("também não marca unknown como verificado", () => {
    const lead = paraNovoLead(candidato({ verificacao: "unknown" }), IDS);
    expect(lead.emailVerified).toBe(false);
  });

  it("recusa candidato sem e-mail", () => {
    expect(() => paraNovoLead(candidato({ email: null }), IDS)).toThrow(
      /não tem e-mail/i,
    );
  });
});
