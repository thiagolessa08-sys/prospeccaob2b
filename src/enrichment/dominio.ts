/**
 * Extrai o domínio de um site, para alimentar a busca por decisor.
 *
 * Aceita com ou sem protocolo (`exemplo.com.br` e `https://exemplo.com.br/`
 * chegam ao mesmo domínio) e remove o `www.` — a Hunter busca pelo domínio
 * nu. Uma URL malformada devolve `null` em vez de lançar: a empresa
 * simplesmente segue sem domínio conhecido, e a cadeia trata isso como
 * "sem site", não como erro.
 */
export function dominioDoSite(website: string | null): string | null {
  if (!website?.trim()) return null;

  const comProtocolo = /^https?:\/\//i.test(website)
    ? website
    : `https://${website}`;

  try {
    const host = new URL(comProtocolo).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}
