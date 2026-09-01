import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { descobrirEmpresas } from "../../discovery/descobrir-empresas.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsDescobrirEmpresasHttp {
  db: Db;
  tenantId: string;
  segredo: string;
  apiKeyCasaDosDados: string;
  apiKeyLusha: string;
}

/**
 * Rota lenta: busca empresas novas na Casa dos Dados a partir do filtro de
 * nicho já salvo na campanha. Chamada pelo n8n na agenda, antes do lote de
 * enriquecimento — é o início do funil, que até aqui não tinha nenhum código.
 */
export async function tratarDescobrirEmpresas(
  req: Request,
  campaignId: string,
  deps: DepsDescobrirEmpresasHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const resultado = await descobrirEmpresas({
    db: deps.db,
    tenantId: deps.tenantId,
    campaignId,
    apiKey: deps.apiKeyCasaDosDados,
    apiKeyLusha: deps.apiKeyLusha,
  });

  return new Response(JSON.stringify(resultado), { status: 200 });
}
