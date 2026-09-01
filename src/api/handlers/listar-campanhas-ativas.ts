import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { listarCampanhasAtivas } from "../../db/repositories/campaigns.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsListarCampanhasAtivasHttp {
  db: Db;
  tenantId: string;
  segredo: string;
}

/**
 * Devolve os IDs das campanhas ativas do tenant.
 *
 * Sem esta rota, o n8n só teria como descobrir quais campanhas existem
 * acessando o banco diretamente — furando a fronteira em que toda decisão de
 * negócio mora atrás de um handler HTTP, a mesma que faz o webhook e as
 * rotas lentas serem testáveis por invocação direta. Com ela, o fluxo do n8n
 * é: liste as ativas, e para cada uma dispare descobrir-empresas,
 * enriquecer-lote, enviar-lote e retomar-followups — sem precisar de uma
 * lista de campanhas hardcoded que fica velha assim que alguém cria uma nova.
 */
export async function tratarListarCampanhasAtivas(
  req: Request,
  deps: DepsListarCampanhasAtivasHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const campanhas = await listarCampanhasAtivas(deps.db, deps.tenantId);

  return new Response(
    JSON.stringify(
      campanhas.map((c) => ({ id: c.id, name: c.name, send_mode: c.send_mode })),
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
