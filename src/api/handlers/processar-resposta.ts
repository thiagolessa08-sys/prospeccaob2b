import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { buscarLead } from "../../db/repositories/leads.js";
import { buscarCampanha } from "../../db/repositories/campaigns.js";
import { processarResposta } from "../../conversation/processar-resposta.js";
import { criarProvedorParaCampanha } from "../../sending/provedor.js";

/** Header do segredo compartilhado com o n8n, que dispara esta rota. */
export const HEADER_SEGREDO_N8N = "x-prospeccao-segredo";

export interface DepsProcessarRespostaHttp {
  db: Db;
  tenantId: string;
  segredo: string;
}

/**
 * Rota lenta: classifica, decide e responde. Chamada pelo n8n depois que o
 * webhook do Instantly já confirmou a chegada da resposta — nunca pelo
 * webhook em si, que precisa responder em segundos.
 */
export async function tratarProcessarResposta(
  req: Request,
  leadId: string,
  deps: DepsProcessarRespostaHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const lead = await buscarLead(deps.db, deps.tenantId, leadId);
  if (!lead) {
    return new Response(JSON.stringify({ erro: "lead não encontrado" }), {
      status: 404,
    });
  }

  const campanha = await buscarCampanha(deps.db, deps.tenantId, lead.campaign_id);
  if (!campanha) {
    return new Response(JSON.stringify({ erro: "campanha não encontrada" }), {
      status: 404,
    });
  }

  const provedor = criarProvedorParaCampanha(deps.db, campanha);

  const resultado = await processarResposta({
    db: deps.db,
    tenantId: deps.tenantId,
    leadId,
    provedor,
  });

  return new Response(JSON.stringify(resultado), { status: 200 });
}
