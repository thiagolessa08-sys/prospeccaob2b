export interface SuppressionRule {
  kind: "email" | "domain";
  value: string;
}

export function normalizeEmail(email: string): string {
  const limpo = email.trim().toLowerCase();
  if (!limpo.includes("@") || limpo.startsWith("@") || limpo.endsWith("@")) {
    throw new Error(`E-mail inválido: ${email}`);
  }
  return limpo;
}

export function extractDomain(email: string): string {
  const normalizado = normalizeEmail(email);
  const posicao = normalizado.lastIndexOf("@");
  return normalizado.slice(posicao + 1);
}

/**
 * Um e-mail malformado é tratado como suprimido: preferimos perder um lead a
 * disparar para um endereço que não conseguimos validar.
 */
export function isSuppressed(
  email: string,
  rules: readonly SuppressionRule[],
): boolean {
  let normalizado: string;
  let dominio: string;
  try {
    normalizado = normalizeEmail(email);
    dominio = extractDomain(email);
  } catch {
    return true;
  }

  return rules.some((regra) => {
    const valor = regra.value.trim().toLowerCase();
    return regra.kind === "email" ? valor === normalizado : valor === dominio;
  });
}

/**
 * Trava obrigatória do caminho de envio: chame antes de qualquer disparo.
 *
 * "Zero envios para endereço suprimido ou inválido" é critério de sucesso do
 * produto, e uma convenção que vive só na cabeça de quem revisa acaba
 * esquecida. Uma função com nome, que estoura, não tem como ser esquecida em
 * silêncio — o envio quebra alto em vez de sair para quem pediu para parar.
 */
export function assertSendable(
  email: string,
  rules: readonly SuppressionRule[],
): void {
  if (isSuppressed(email, rules)) {
    throw new Error(
      `Envio bloqueado: o endereço ${email} está suprimido ou é inválido.`,
    );
  }
}

export function ruleForOptOut(email: string): SuppressionRule {
  return { kind: "email", value: normalizeEmail(email) };
}
