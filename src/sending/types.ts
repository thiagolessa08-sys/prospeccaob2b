/** Vocabulário do envio. Nenhum termo de fornecedor aparece aqui. */

export interface EmailParaEnviar {
  tenantId: string;
  leadId: string;
  email: string;
  primeiroNome: string | null;
  sobrenome: string | null;
  empresa: string | null;
  site: string | null;
  assunto: string;
  corpo: string;
}

export type ResultadoDoEnvio =
  | { enviado: true; externalId: string | null; sombra: boolean }
  | { enviado: false; motivo: string };

/**
 * A fronteira com o fornecedor de disparo.
 *
 * Existe porque a escolha do Instantly depende de um padrão que a documentação
 * dele não descreve (assunto e corpo por lead via custom variables). Se ele não
 * servir, trocar de fornecedor precisa ser um arquivo, não uma reescrita.
 */
export interface ColdEmailProvider {
  enviar(email: EmailParaEnviar): Promise<ResultadoDoEnvio>;
  /**
   * `null` quando o fornecedor não sabe informar — a sombra, por exemplo.
   *
   * Sem parâmetro de propósito: o provedor já sabe qual é a campanha *dele*.
   * Passar o id da nossa campanha era o bug — o adaptador do Instantly tratava
   * o UUID do nosso banco como id do Instantly, nunca casava, e o disjuntor
   * caía calado no fallback local.
   */
  contarBounces(): Promise<{ enviados: number; bounces: number } | null>;
}
