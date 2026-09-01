import { env } from "../config/env.js";
import type { Db } from "../db/port.js";
import type { Campaign } from "../db/types.js";
import { criarProvedorDeSombra } from "./shadow.js";
import { criarProvedorInstantly } from "./instantly.js";
import type { ColdEmailProvider } from "./types.js";

/**
 * Escolhe o provedor a partir de `campaigns.send_mode`, em vez de deixar quem
 * chama decidir. `enviarLote` já recusa um provedor que divirja do modo da
 * campanha — mas essa trava só protege quem já chegou até ela. Centralizar a
 * escolha aqui é o que torna impossível, em qualquer novo caminho de chamada,
 * montar o adaptador errado.
 */
export function criarProvedorParaCampanha(
  db: Db,
  campanha: Campaign,
): ColdEmailProvider {
  if (campanha.send_mode === "shadow") {
    return criarProvedorDeSombra(db);
  }

  const ambiente = env();
  return criarProvedorInstantly({
    apiKey: ambiente.INSTANTLY_API_KEY,
    campanhaInstantly: ambiente.INSTANTLY_CAMPAIGN_ID,
    db,
    premissaValidadaEm: ambiente.INSTANTLY_PREMISSA_VALIDADA_EM,
  });
}
