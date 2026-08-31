import type { LeadStage } from "../db/types.js";

const TERMINAIS: readonly LeadStage[] = ["meeting_booked", "discarded"];

/** Avanços permitidos no funil, sem contar descarte e erro. */
const AVANCOS: Record<LeadStage, readonly LeadStage[]> = {
  discovered: ["enriched"],
  enriched: ["contacted"],
  contacted: ["in_conversation"],
  in_conversation: ["meeting_booked"],
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
