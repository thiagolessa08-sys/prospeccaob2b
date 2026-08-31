/**
 * Teste de contrato contra a BrasilAPI de verdade. Pulado por padrão.
 *
 *   LIVE_API=1 npm test
 *   LIVE_API=1 npx vitest run tests/enrichment/brasilapi.live.test.ts
 *
 * Por que existe: o funil inteiro gira numa comparação exata de string em
 * src/enrichment/brasilapi.ts — `descricao_situacao_cadastral === "ATIVA"`. Se
 * esse valor um dia chegar como "Ativa", ou com espaço no fim,
 * `enriquecerDecisor` classifica *toda empresa do Brasil* como inativa,
 * devolve zero leads, gasta zero crédito e registra um motivo plausível. Nada
 * na suíte de mocks pegaria isso, porque os mocks repetem a suposição.
 *
 * A BrasilAPI é gratuita e não pede autenticação, então a checagem não custa
 * nada. Não há equivalente para a Hunter: lá cada chamada queima um crédito e
 * exige chave.
 */
import { describe, it, expect } from "vitest";
import { buscarEmpresaPorCnpj } from "../../src/enrichment/brasilapi.js";

/** Banco do Brasil — CNPJ público, ativo e estável há décadas. */
const CNPJ_ESTAVEL = "00000000000191";

describe.skipIf(!process.env.LIVE_API)("BrasilAPI — contrato ao vivo", () => {
  it(
    "responde no formato que o adaptador supõe, com a empresa ativa",
    async () => {
      const empresa = await buscarEmpresaPorCnpj(CNPJ_ESTAVEL);

      expect(empresa).not.toBeNull();
      if (!empresa) throw new Error("esperava a empresa");

      // A asserção que justifica o teste: se `descricao_situacao_cadastral`
      // mudar de grafia, `ativa` vira false para todo mundo.
      expect(empresa.ativa).toBe(true);

      expect(empresa.razaoSocial.length).toBeGreaterThan(0);
      expect(empresa.cnaePrincipal).toMatch(/^\d+$/);
      expect(Array.isArray(empresa.socios)).toBe(true);
    },
    30_000,
  );
});
