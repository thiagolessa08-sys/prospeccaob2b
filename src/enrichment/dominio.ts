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

/** Provedores de caixa pessoal: o domínio não é o da empresa. */
const PROVEDORES_PESSOAIS = new Set([
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "outlook.com.br",
  "live.com",
  "yahoo.com",
  "yahoo.com.br",
  "bol.com.br",
  "uol.com.br",
  "terra.com.br",
  "ig.com.br",
  "globo.com",
  "icloud.com",
  "me.com",
  "protonmail.com",
]);

/**
 * Extrai o domínio corporativo do e-mail que a empresa declarou à Receita.
 *
 * É o que salva o enriquecimento das empresas vindas da Casa dos Dados: a
 * busca avançada de lá não devolve site nenhum, então sem esta função toda
 * empresa descoberta chegaria à cadeia sem domínio — e a cadeia recusa
 * procurar decisor sem domínio. O e-mail da Receita é gratuito, já vem na
 * mesma consulta de CNPJ que a cadeia faz de qualquer jeito, e serve mesmo
 * quando é uma caixa genérica: `contato@empresa.com.br` não presta como
 * destinatário, mas diz que o domínio é `empresa.com.br` — que é exatamente
 * o que a Hunter precisa para procurar as pessoas.
 *
 * Devolve `null` para caixa em provedor pessoal (gmail, hotmail): o domínio
 * ali é do provedor, e procurar decisores "no gmail.com" não significa nada.
 */
export function dominioDoEmail(email: string | null): string | null {
  const limpo = email?.trim().toLowerCase();
  if (!limpo) return null;

  const arroba = limpo.lastIndexOf("@");
  if (arroba < 1 || arroba === limpo.length - 1) return null;

  const dominio = limpo.slice(arroba + 1);
  if (!dominio.includes(".") || dominio.includes(" ")) return null;

  return PROVEDORES_PESSOAIS.has(dominio) ? null : dominio;
}
