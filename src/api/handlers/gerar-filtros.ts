import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { gerarFiltros } from "../../discovery/gerar-filtros.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsGerarFiltrosHttp {
  db: Db;
  tenantId: string;
  segredo: string;
}

/**
 * Rota lenta: transforma a descrição do nicho em filtros estruturados via
 * IA. Chamada uma vez, depois de criar a campanha — e de novo, sozinha, se a
 * primeira tentativa falhar.
 */
export async function tratarGerarFiltros(
  req: Request,
  campaignId: string,
  deps: DepsGerarFiltrosHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const resultado = await gerarFiltros({
    db: deps.db,
    tenantId: deps.tenantId,
    campaignId,
  });

  if (!resultado.gerado) {
    const status = resultado.motivo === "Campanha não encontrada." ? 404 : 502;
    return new Response(JSON.stringify(resultado), { status });
  }
  return new Response(JSON.stringify(resultado), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
