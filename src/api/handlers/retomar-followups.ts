import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { buscarCampanha } from "../../db/repositories/campaigns.js";
import { retomarFollowups } from "../../conversation/retomar-followups.js";
import { criarProvedorParaCampanha } from "../../sending/provedor.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsRetomarFollowupsHttp {
  db: Db;
  tenantId: string;
  segredo: string;
}

/**
 * Rota lenta: reabre contato com os leads cujo "não agora" já venceu o
 * prazo. O n8n agenda — não existe webhook que dispare isto, o gatilho é o
 * relógio.
 */
export async function tratarRetomarFollowups(
  req: Request,
  campaignId: string,
  deps: DepsRetomarFollowupsHttp,
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
  const resultado = await retomarFollowups({
    db: deps.db,
    tenantId: deps.tenantId,
    campaignId,
    provedor,
  });

  return new Response(JSON.stringify(resultado), { status: 200 });
}
