import { normalizeEmail } from "../domain/suppression.js";

/**
 * Prefixos de caixa compartilhada. A comparação é por igualdade exata da parte
 * local, nunca por prefixo de string: "informatica@" começa com "info" mas é
 * um endereço legítimo de setor, e "contatore@" começa com "contato".
 */
export const PREFIXOS_GENERICOS: readonly string[] = [
  "contato",
  "comercial",
  "vendas",
  "sac",
  "atendimento",
  "financeiro",
  "rh",
  "faleconosco",
  "fale-conosco",
  "ouvidoria",
  "compras",
  "juridico",
  "marketing",
  "suporte",
  "info",
  "sales",
  "support",
  "admin",
  "hello",
  "hi",
  "contact",
  "office",
  "team",
  "help",
  "noreply",
  "no-reply",
  "donotreply",
  "postmaster",
  "webmaster",
  "abuse",
  "billing",
];

/**
 * Um e-mail malformado conta como genérico: preferimos descartar o candidato a
 * gravar como decisor um endereço que não conseguimos sequer interpretar.
 */
export function ehEmailGenerico(email: string): boolean {
  let normalizado: string;
  try {
    normalizado = normalizeEmail(email);
  } catch {
    return true;
  }
  const parteLocal = normalizado.slice(0, normalizado.lastIndexOf("@"));
  return PREFIXOS_GENERICOS.includes(parteLocal);
}
