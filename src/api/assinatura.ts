import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compara duas cadeias em tempo constante.
 *
 * `timingSafeEqual` **lança** quando os buffers têm tamanhos diferentes, em vez
 * de devolver `false`. Sem a guarda de tamanho, uma assinatura curta ou ausente
 * derrubaria o handler com 500 — e um 5xx faz o remetente reentregar o webhook
 * para sempre, transformando uma requisição forjada num laço infinito.
 */
function comparaEmTempoConstante(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Verifica a assinatura HMAC-SHA256 do Cal.com sobre o corpo cru.
 *
 * Tem que ser o corpo **cru**: reserializar o JSON muda espaçamento e ordem de
 * chaves, e a assinatura deixa de bater.
 *
 * Um segredo vazio devolve `false` em vez de aceitar — o segredo é opcional no
 * Cal.com, e deixá-lo em branco tornaria a verificação uma formalidade que
 * aprova qualquer requisição.
 */
export function assinaturaHmacConfere(
  corpoBruto: string,
  recebida: string | null,
  segredo: string,
): boolean {
  if (!segredo) return false;
  if (!recebida) return false;
  const esperada = createHmac("sha256", segredo).update(corpoBruto).digest("hex");
  return comparaEmTempoConstante(esperada, recebida);
}

/**
 * Verifica um segredo compartilhado enviado em header.
 *
 * É o que o Instantly oferece: ele não assina os webhooks, então o melhor
 * disponível é um segredo que nós definimos no registro e conferimos aqui.
 * Mais fraco que HMAC — o segredo viaja em toda requisição — o que torna HTTPS
 * um requisito, não uma recomendação.
 */
export function segredoConfere(
  recebido: string | null,
  esperado: string,
): boolean {
  if (!esperado) return false;
  if (!recebido) return false;
  return comparaEmTempoConstante(esperado, recebido);
}
