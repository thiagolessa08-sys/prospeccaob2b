import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { enriquecerLote } from "../../enrichment/enriquecer-lote.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsEnriquecerLoteHttp {
  db: Db;
  tenantId: string;
  segredo: string;
  apiKeyHunter: string;
}

/**
 * Rota lenta: acha o decisor de cada empresa pendente da campanha. Chamada
 * pelo n8n na agenda — a cadeia consulta a BrasilAPI e, quando precisa, a
 * Hunter, uma empresa de cada vez.
 */
export async function tratarEnriquecerLote(
  req: Request,
  campaignId: string,
  deps: DepsEnriquecerLoteHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const resultado = await enriquecerLote({
    db: deps.db,
    tenantId: deps.tenantId,
    campaignId,
    apiKeyHunter: deps.apiKeyHunter,
  });

  return new Response(JSON.stringify(resultado), { status: 200 });
}
