import type { LeadStage } from "../db/types.js";

const TERMINAIS: readonly LeadStage[] = ["meeting_booked", "discarded"];

/** Transições permitidas no funil, sem contar descarte e erro. */
const AVANCOS: Record<LeadStage, readonly LeadStage[]> = {
  discovered: ["enriched"],
  enriched: ["contacted"],
  // `meeting_booked` sai daqui também: o link de agendamento só é enviado numa
  // réplica, mas ele pode ser encaminhado, e o lead pode agendar sem responder.
  // Recusar essa transição faria o webhook falhar justamente no desfecho que o
  // sistema existe para produzir.
  contacted: ["in_conversation", "meeting_booked"],
  // 'contacted' é o único retorno permitido no funil: qualquer resposta que
  // chega move o lead para 'in_conversation' antes de ser classificada, e uma
  // resposta automática de ausência ("estou de férias", "não trabalha mais
  // aqui") é classificada como out_of_scope depois disso. Sem esta volta, um
  // auto-respondedor deixaria o lead marcado como conversa ativa para sempre.
  in_conversation: ["meeting_booked", "contacted"],
  meeting_booked: [],
  discarded: [],
  // Erro é reprocessável: volta para qualquer estágio ativo do funil.
  error: ["discovered", "enriched", "contacted", "in_conversation"],
};

export function isTerminal(stage: LeadStage): boolean {
  return TERMINAIS.includes(stage);
}

export function canTransition(from: LeadStage, to: LeadStage): boolean {
  if (from === to) return false;
  if (isTerminal(from)) return false;
  if (AVANCOS[from].includes(to)) return true;
  // Descarte e erro são alcançáveis de qualquer estágio ativo, inclusive 'error'.
  return to === "discarded" || to === "error";
}

export function assertTransition(from: LeadStage, to: LeadStage): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transição de estágio inválida: ${from} -> ${to}`);
  }
}
