import { createHmac } from "node:crypto";
import { segredoConfere } from "./assinatura.js";

/**
 * A sessão do operador no painel.
 *
 * Um cookie assinado, e não o segredo colado a cada aba: `HttpOnly` tira o
 * valor do alcance do JavaScript da própria página, então um XSS no painel
 * deixa de ser um vazamento da credencial. O navegador o reenvia sozinho, o
 * que também resolve a parte chata — ninguém cola nada de novo.
 *
 * Sem estado no servidor de propósito: a validade viaja dentro do próprio
 * cookie e é a assinatura que a torna inviolável. Guardar sessões em memória
 * derrubaria todo mundo a cada deploy do Railway, que reinicia o processo.
 *
 * A contrapartida é que uma sessão emitida não pode ser revogada uma a uma
 * antes de expirar. Para revogar todas, troque `PAINEL_SENHA`: ela é a chave
 * da assinatura, então trocá-la invalida tudo o que já foi emitido.
 */
export const COOKIE_DO_PAINEL = "painel_sessao";

/** Doze horas — um turno. Depois disso o operador entra de novo. */
const VALIDADE_MS = 12 * 60 * 60 * 1000;

/**
 * O prefixo entra na mensagem assinada para o HMAC valer só para esta
 * finalidade. Sem ele, uma assinatura gerada em outro ponto do sistema com a
 * mesma chave passaria a valer como sessão de painel.
 */
function assinar(expiraEm: number, senha: string): string {
  return createHmac("sha256", senha).update("painel." + expiraEm).digest("hex");
}

/** Lê um cookie do header `Cookie` cru, sem depender de biblioteca. */
function lerCookie(header: string | null, nome: string): string | null {
  if (!header) return null;
  for (const pedaco of header.split(";")) {
    const igual = pedaco.indexOf("=");
    if (igual < 0) continue;
    if (pedaco.slice(0, igual).trim() !== nome) continue;
    return pedaco.slice(igual + 1).trim();
  }
  return null;
}

/** Valor do cookie: quando expira, e a prova de que fomos nós que emitimos. */
export function criarSessao(senha: string, agora: number = Date.now()): string {
  const expiraEm = agora + VALIDADE_MS;
  return expiraEm + "." + assinar(expiraEm, senha);
}

/**
 * Confere a sessão que veio no header `Cookie`.
 *
 * Senha vazia recusa sempre. É o mesmo desenho de `assinaturaHmacConfere`:
 * sem chave configurada, a verificação viraria formalidade que aprova
 * qualquer requisição — e aqui isso abriria o painel inteiro a quem
 * descobrisse a URL.
 */
export function sessaoConfere(
  cookieHeader: string | null,
  senha: string,
  agora: number = Date.now(),
): boolean {
  if (!senha) return false;

  const valor = lerCookie(cookieHeader, COOKIE_DO_PAINEL);
  if (!valor) return false;

  const ponto = valor.indexOf(".");
  if (ponto < 1) return false;

  const expiraEm = Number(valor.slice(0, ponto));
  if (!Number.isFinite(expiraEm) || expiraEm <= agora) return false;

  return segredoConfere(valor.slice(ponto + 1), assinar(expiraEm, senha));
}

/**
 * `Secure` mesmo em desenvolvimento: os navegadores tratam `localhost` como
 * origem confiável e aceitam o cookie ali, então não há custo — e deixá-lo
 * condicional criaria o ambiente em que a sessão trafega em claro.
 *
 * `SameSite=Strict` porque o painel é sempre navegação direta: nenhum site de
 * terceiro tem motivo para disparar requisição autenticada para cá.
 */
export function cabecalhoDeSessao(valor: string): string {
  const segundos = Math.floor(VALIDADE_MS / 1000);
  return `${COOKIE_DO_PAINEL}=${valor}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${segundos}`;
}

/** Mesmos atributos, `Max-Age=0`: o navegador só apaga o cookie que casa. */
export function cabecalhoDeSaida(): string {
  return `${COOKIE_DO_PAINEL}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}
