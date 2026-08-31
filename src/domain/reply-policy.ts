import type { ReplyClassification } from "../ai/reply-classifier.js";

/** Abaixo disso, um humano decide. */
export const CONFIDENCE_THRESHOLD = 0.7;

/** Trocas com o lead antes de a automação entregar a conversa a um humano. */
export const MAX_EXCHANGES = 5;

/** Espera antes de retomar um lead que pediu para ser procurado depois. */
export const NOT_NOW_RESUME_DAYS = 90;

export type NextAction =
  | { type: "send_scheduling_link" }
  | { type: "answer_and_nudge"; keyPoints: string[] }
  | { type: "schedule_followup"; resumeInDays: number }
  | { type: "close_lost"; reason: string; suppress: boolean }
  | { type: "handoff_to_human"; reason: string }
  | { type: "ignore"; reason: string };

export function decideNextAction(input: {
  classification: ReplyClassification;
  exchangeCount: number;
}): NextAction {
  const { classification, exchangeCount } = input;

  // Descadastro vem antes de qualquer trava: continuar escrevendo para quem
  // pediu para parar é pior — e mais arriscado sob a LGPD — do que perder o lead.
  if (classification.intent === "opt_out") {
    return {
      type: "close_lost",
      reason: "pedido de descadastro",
      suppress: true,
    };
  }

  if (classification.confidence < CONFIDENCE_THRESHOLD) {
    return {
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    };
  }

  // Recusa clara encerra em vez de virar trabalho para um humano.
  if (classification.intent === "no") {
    return { type: "close_lost", reason: "recusa do lead", suppress: false };
  }

  if (classification.intent === "out_of_scope") {
    return { type: "ignore", reason: "resposta fora do escopo" };
  }

  if (exchangeCount >= MAX_EXCHANGES) {
    return { type: "handoff_to_human", reason: "conversa longa sem desfecho" };
  }

  switch (classification.intent) {
    case "interested":
      return { type: "send_scheduling_link" };
    case "question_or_objection":
      return { type: "answer_and_nudge", keyPoints: classification.key_points };
    case "not_now":
      return {
        type: "schedule_followup",
        resumeInDays: NOT_NOW_RESUME_DAYS,
      };
  }
}
