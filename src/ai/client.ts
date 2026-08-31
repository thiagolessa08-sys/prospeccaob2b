import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

/** Modelo único de toda a plataforma. */
export const MODEL = "claude-opus-5";

let cache: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!cache) {
    cache = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  }
  return cache;
}

/** Dependências injetáveis dos módulos de IA — permite testar sem rede. */
export interface AiDeps {
  client: Pick<Anthropic, "messages">;
}
