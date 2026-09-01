import { z } from "zod";

/**
 * O que o Postgres aceita numa coluna `uuid`: 8-4-4-4-12 em hexadecimal.
 * Deliberadamente mais frouxo que a RFC 4122 — o banco não checa versão nem
 * variante, e validar mais que ele só cria falso negativo no boot.
 *
 * Exportado porque `src/db/migrar.ts` valida o mesmo TENANT_ID sem passar por
 * `env()` (ele roda sozinho, antes do servidor, e não precisa das outras
 * variáveis). Duas cópias da regra divergiriam.
 */
export const UUID_DO_POSTGRES =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  /** Connection string do Postgres. É por aqui que TODA a persistência passa. */
  DATABASE_URL: z.string().min(1),
  HUNTER_API_KEY: z.string().min(1),
  CASA_DOS_DADOS_API_KEY: z.string().min(1),
  INSTANTLY_API_KEY: z.string().min(1),
  INSTANTLY_CAMPAIGN_ID: z.string().min(1),
  /**
   * Formato validado no boot, e não só `min(1)`: a coluna `tenant_id` é
   * `uuid` no Postgres, então um valor fora do formato passa no boot e só
   * explode na primeira consulta, como `invalid input syntax for type uuid` —
   * erro que aponta para o banco quando o problema é a variável de ambiente.
   *
   * Regex em vez de `z.uuid()` de propósito: o zod exige conformidade com a
   * RFC 4122 (dígitos de versão e variante), que o Postgres NÃO exige.
   * Validar mais que o banco recusaria no boot um id que funcionaria bem —
   * `11111111-1111-1111-1111-111111111111`, por exemplo, que os testes usam.
   */
  TENANT_ID: z
    .string()
    .regex(UUID_DO_POSTGRES, "TENANT_ID precisa ter o formato 8-4-4-4-12 em hexadecimal"),
  INSTANTLY_WEBHOOK_SECRET: z.string().min(1),
  CALCOM_WEBHOOK_SECRET: z.string().min(1),
  /**
   * Vazio por padrão: sem uma validação real registrada, o provedor do
   * Instantly recusa construir — o produto inteiro depende de um padrão
   * (assunto e corpo por lead em custom variables) que a documentação dele
   * não descreve. Preencher aqui é o ato deliberado de dizer "já testei".
   */
  INSTANTLY_PREMISSA_VALIDADA_EM: z.string().optional().default(""),
  N8N_SHARED_SECRET: z.string().min(1),
  /**
   * Senha do painel do operador. Opcional, e vazia por padrão, porque
   * torná-la obrigatória faria todo deploy já existente parar de subir no
   * instante em que este código chegasse ao servidor — trocando "painel
   * indisponível" por "serviço fora do ar". Vazia, o painel recusa login com
   * 503 e o resto da API segue funcionando.
   *
   * Também é a chave que assina o cookie de sessão, então vale ser longa e
   * aleatória: trocá-la invalida todas as sessões abertas de uma vez.
   */
  PAINEL_SENHA: z.string().optional().default(""),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  const resultado = EnvSchema.safeParse(source);
  if (!resultado.success) {
    const faltando = resultado.error.issues
      .map((problema) => problema.path.join("."))
      .join(", ");
    throw new Error(`Variáveis de ambiente inválidas ou ausentes: ${faltando}`);
  }
  return resultado.data;
}

let cache: Env | null = null;

/** Lê e valida o ambiente do processo na primeira chamada. */
export function env(): Env {
  if (!cache) cache = loadEnv(process.env);
  return cache;
}
