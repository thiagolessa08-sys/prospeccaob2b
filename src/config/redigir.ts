/**
 * Tira segredos de um texto antes de ele virar log.
 *
 * Existe porque um erro de biblioteca embute com frequência a credencial que
 * causou a falha — o `pg` põe a connection string inteira na mensagem, e foi
 * assim que a senha do Postgres foi parar onze vezes, em texto claro, no log
 * do Railway. Redigir na borda de saída (o log) e não em cada `catch` é o que
 * torna a proteção difícil de esquecer.
 *
 * Lê os valores do próprio ambiente em vez de tentar reconhecer formatos:
 * casar `sk-ant-...` por regex protege só o que já se sabe que existe, e uma
 * chave nova de fornecedor novo passaria batida.
 */
const CHAVES_SECRETAS = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "HUNTER_API_KEY",
  "CASA_DOS_DADOS_API_KEY",
  "INSTANTLY_API_KEY",
  "N8N_SHARED_SECRET",
  "INSTANTLY_WEBHOOK_SECRET",
  "CALCOM_WEBHOOK_SECRET",
] as const;

/**
 * Curto demais não é segredo, é palavra comum: redigir um valor de 3 letras
 * picotaria o texto inteiro sem proteger nada.
 */
const TAMANHO_MINIMO = 8;

export function semSegredos(
  texto: string,
  ambiente: NodeJS.ProcessEnv = process.env,
): string {
  let limpo = texto;

  for (const chave of CHAVES_SECRETAS) {
    const valor = ambiente[chave]?.trim();
    if (valor && valor.length >= TAMANHO_MINIMO) {
      limpo = limpo.split(valor).join(`[${chave}]`);
    }
  }

  // A senha dentro da DATABASE_URL também aparece sozinha, sem o resto da
  // string, em algumas mensagens do driver.
  const banco = ambiente.DATABASE_URL?.trim();
  if (banco) {
    try {
      const senha = new URL(banco).password;
      if (senha) limpo = limpo.split(senha).join("***");
    } catch {
      // URL malformada não tem senha isolável; o laço acima já cobriu o caso
      // de a string inteira aparecer na mensagem.
    }
  }

  return limpo;
}
