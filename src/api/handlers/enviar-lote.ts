import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { buscarCampanha } from "../../db/repositories/campaigns.js";
import { enviarLote } from "../../sending/enviar-lote.js";
import { criarProvedorParaCampanha } from "../../sending/provedor.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsEnviarLoteHttp {
  db: Db;
  tenantId: string;
  segredo: string;
}

/**
 * Rota lenta: dispara o disparo diário de uma campanha. Chamada pelo n8n na
 * agenda — escrever um e-mail por lead são chamadas ao Claude, e um lote de
 * 50 leads leva minutos.
 */
export async function tratarEnviarLote(
  req: Request,
  campaignId: string,
  deps: DepsEnviarLoteHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const campanha = await buscarCampanha(deps.db, deps.tenantId, campaignId);
  if (!campanha) {
    return new Response(JSON.stringify({ erro: "campanha não encontrada" }), {
      status: 404,
    });
  }

  const provedor = criarProvedorParaCampanha(deps.db, campanha);
  const resultado = await enviarLote({
    db: deps.db,
    tenantId: deps.tenantId,
    campaignId,
    provedor,
  });

  return new Response(JSON.stringify(resultado), { status: 200 });
}
