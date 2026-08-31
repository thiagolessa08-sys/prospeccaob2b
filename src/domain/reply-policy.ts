import type { ReplyClassification } from "../ai/reply-classifier.js";

/** Abaixo disso, um humano decide. */
export const CONFIDENCE_THRESHOLD = 0.7;

/** Trocas com o lead antes de a automação entregar a conversa a um humano. */
export const MAX_EXCHANGES = 5;

/** Espera padrão, usada só quando o lead não indicou prazo nenhum. */
export const NOT_NOW_RESUME_DAYS = 90;

/** Teto do prazo pedido pelo lead: acima de um ano, tratamos como erro do modelo. */
const MAX_RESUME_DAYS = 365;

/**
 * O prazo que o próprio lead pediu vale mais do que a constante: quem escreveu
 * "me procure em duas semanas" não deve ouvir "retomo em 90 dias". O valor vem
 * do modelo, então só é aceito se for um número de dias plausível.
 */
function diasDeRetomada(sugestao: number | null): number {
  if (sugestao === null || !Number.isFinite(sugestao)) {
    return NOT_NOW_RESUME_DAYS;
  }
  const dias = Math.round(sugestao);
  if (dias < 1 || dias > MAX_RESUME_DAYS) return NOT_NOW_RESUME_DAYS;
  return dias;
}

/**
 * Os campos `reason` são texto para humano lerem no painel e nos logs: podem
 * mudar de redação a qualquer momento. Nada deve ramificar sobre eles — se
 * algum fluxo precisar distinguir motivos, converta antes para uma união de
 * literais própria em vez de comparar estas frases.
 */
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
  /** O lead já foi entregue a um humano em alguma rodada anterior. */
  needsHuman: boolean;
}): NextAction {
  const { classification, exchangeCount, needsHuman } = input;

  // Descadastro vem antes de qualquer trava: continuar escrevendo para quem
  // pediu para parar é pior — e mais arriscado sob a LGPD — do que perder o lead.
  if (classification.intent === "opt_out") {
    return {
      type: "close_lost",
      reason: "pedido de descadastro",
      suppress: true,
    };
  }

  // Uma vez entregue a um humano, a automação não retoma a conversa sozinha:
  // sem esta trava a próxima resposta do lead seria classificada e respondida
  // como se o repasse nunca tivesse acontecido.
  if (needsHuman) {
    return { type: "handoff_to_human", reason: "lead já entregue a um humano" };
  }

  // Comparar direto (`confidence < LIMITE`) falharia para o lado aberto: com
  // NaN a comparação é falsa e a automação seguiria escrevendo ao lead. O
  // Plano 2 vai remontar esta classificação a partir de `messages.confidence`,
  // que é `numeric` anulável — um `Number(null)` basta para produzir NaN.
  if (
    !Number.isFinite(classification.confidence) ||
    classification.confidence < CONFIDENCE_THRESHOLD
  ) {
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

  // Contagem não finita conta como teto atingido, pelo mesmo motivo da
  // confiança: na dúvida sobre o número, quem decide é um humano.
  if (!Number.isFinite(exchangeCount) || exchangeCount >= MAX_EXCHANGES) {
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
        resumeInDays: diasDeRetomada(classification.suggested_resume_days),
      };
  }
}
