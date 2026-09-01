import { z } from "zod";

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  /** Connection string do Postgres. É por aqui que TODA a persistência passa. */
  DATABASE_URL: z.string().min(1),
  HUNTER_API_KEY: z.string().min(1),
  CASA_DOS_DADOS_API_KEY: z.string().min(1),
  INSTANTLY_API_KEY: z.string().min(1),
  INSTANTLY_CAMPAIGN_ID: z.string().min(1),
  TENANT_ID: z.string().min(1),
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
