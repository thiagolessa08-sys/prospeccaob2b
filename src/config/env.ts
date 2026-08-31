import { z } from "zod";

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
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
