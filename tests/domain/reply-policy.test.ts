import { describe, it, expect } from "vitest";
import {
  decideNextAction,
  CONFIDENCE_THRESHOLD,
  MAX_EXCHANGES,
  NOT_NOW_RESUME_DAYS,
} from "../../src/domain/reply-policy.js";
import type { ReplyClassification } from "../../src/ai/reply-classifier.js";

function classificacao(
  overrides: Partial<ReplyClassification> = {},
): ReplyClassification {
  return {
    intent: "interested",
    confidence: 0.95,
    reasoning: "motivo",
    key_points: [],
    ...overrides,
  };
}

describe("decideNextAction — caminhos por intenção", () => {
  it("envia o link de agendamento para lead interessado", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "interested" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({ type: "send_scheduling_link" });
  });

  it("responde e conduz ao agendamento quando há dúvida ou objeção", () => {
    const acao = decideNextAction({
      classification: classificacao({
        intent: "question_or_objection",
        key_points: ["preço", "prazo"],
      }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "answer_and_nudge",
      keyPoints: ["preço", "prazo"],
    });
  });

  it("agenda retomada futura em 'não agora'", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "not_now" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "schedule_followup",
      resumeInDays: NOT_NOW_RESUME_DAYS,
    });
  });

  it("encerra sem suprimir em recusa simples", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "no" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "recusa do lead",
      suppress: false,
    });
  });

  it("encerra e suprime em pedido de descadastro", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "opt_out" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "pedido de descadastro",
      suppress: true,
    });
  });

  it("ignora respostas fora do escopo", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "out_of_scope" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "ignore",
      reason: "resposta fora do escopo",
    });
  });
});

describe("decideNextAction — travas de segurança", () => {
  it("honra o descadastro mesmo com confiança baixa", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "opt_out", confidence: 0.1 }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "pedido de descadastro",
      suppress: true,
    });
  });

  it("honra o descadastro mesmo com a conversa já longa", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "opt_out" }),
      exchangeCount: 99,
    });
    expect(acao.type).toBe("close_lost");
  });

  it("passa para humano quando a confiança fica abaixo do limite", () => {
    const acao = decideNextAction({
      classification: classificacao({
        intent: "interested",
        confidence: CONFIDENCE_THRESHOLD - 0.01,
      }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    });
  });

  it("aceita a classificação exatamente no limite de confiança", () => {
    const acao = decideNextAction({
      classification: classificacao({ confidence: CONFIDENCE_THRESHOLD }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({ type: "send_scheduling_link" });
  });

  it("passa para humano ao atingir o teto de trocas", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "question_or_objection" }),
      exchangeCount: MAX_EXCHANGES,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "conversa longa sem desfecho",
    });
  });

  it("ainda automatiza na troca imediatamente anterior ao teto", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "question_or_objection" }),
      exchangeCount: MAX_EXCHANGES - 1,
    });
    expect(acao.type).toBe("answer_and_nudge");
  });

  it("encerra recusa clara sem passar por humano, mesmo em conversa longa", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "no" }),
      exchangeCount: MAX_EXCHANGES + 3,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "recusa do lead",
      suppress: false,
    });
  });

  it("prioriza confiança baixa sobre o teto de trocas", () => {
    const acao = decideNextAction({
      classification: classificacao({ confidence: 0.2 }),
      exchangeCount: MAX_EXCHANGES + 1,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    });
  });

  it("passa para humano quando a recusa vem com confiança baixa", () => {
    const acao = decideNextAction({
      classification: classificacao({
        intent: "no",
        confidence: CONFIDENCE_THRESHOLD - 0.01,
      }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    });
  });

  it("passa para humano quando a resposta fora do escopo vem com confiança baixa", () => {
    const acao = decideNextAction({
      classification: classificacao({
        intent: "out_of_scope",
        confidence: CONFIDENCE_THRESHOLD - 0.01,
      }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    });
  });

  it("ignora resposta fora do escopo mesmo em conversa longa", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "out_of_scope" }),
      exchangeCount: MAX_EXCHANGES + 2,
    });
    expect(acao).toEqual({
      type: "ignore",
      reason: "resposta fora do escopo",
    });
  });
});
