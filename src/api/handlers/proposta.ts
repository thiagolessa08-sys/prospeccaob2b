import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { UUID_DO_POSTGRES } from "../../config/env.js";
import { buscarCampanha, salvarProposta } from "../../db/repositories/campaigns.js";
import {
  proporParaRevisao,
  aprovarPropostaDaCampanha,
} from "../../discovery/propor-campanha.js";
import { PropostaSchema } from "../../ai/proposta.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsPropostaHttp {
  db: Db;
  tenantId: string;
  segredo: string;
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recusar(req: Request, id: string, segredo: string): Response | null {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }
  if (!UUID_DO_POSTGRES.test(id)) {
    return json({ erro: "id não é um uuid válido" }, 400);
  }
  return null;
}

/**
 * Pede à IA a campanha proposta a partir do propósito da solução.
 *
 * Rota lenta e cara — uma chamada de raciocínio alto ao modelo. Pode ser
 * repetida à vontade: o resultado é rascunho e sobrescreve só rascunho.
 */
export async function tratarProporCampanha(
  req: Request,
  campaignId: string,
  deps: DepsPropostaHttp,
): Promise<Response> {
  const recusa = recusar(req, campaignId, deps.segredo);
  if (recusa) return recusa;

  const resultado = await proporParaRevisao({
    db: deps.db,
    tenantId: deps.tenantId,
    campaignId,
  });

  return resultado.proposto
    ? json(resultado.proposta)
    : json({ erro: resultado.motivo }, 422);
}

/**
 * Grava a proposta editada pela pessoa.
 *
 * Valida com o mesmo schema que a IA teve de obedecer. Não é formalidade: a
 * aprovação lê este JSON de volta para escrever `niche_description` e
 * `offer_description`, e um campo faltando aqui viraria `undefined` gravado
 * numa coluna `not null` — erro que apareceria na aprovação, longe daqui.
 */
export async function tratarSalvarProposta(
  req: Request,
  campaignId: string,
  deps: DepsPropostaHttp,
): Promise<Response> {
  const recusa = recusar(req, campaignId, deps.segredo);
  if (recusa) return recusa;

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return json({ erro: "corpo não é JSON válido" }, 400);
  }

  const validada = PropostaSchema.safeParse(corpo);
  if (!validada.success) {
    return json(
      {
        erro: "proposta inválida",
        detalhe: validada.error.issues.map(
          (i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`,
        ),
      },
      400,
    );
  }

  const campanha = await buscarCampanha(deps.db, deps.tenantId, campaignId);
  if (!campanha) return json({ erro: "campanha não encontrada" }, 404);

  await salvarProposta(deps.db, deps.tenantId, campaignId, validada.data);
  return json(validada.data);
}

/**
 * Aprova o que está gravado e promove a campanha.
 *
 * Depois disto, `gerar-filtros` precisa rodar: a aprovação zera `filters`, que
 * foram derivados do nicho anterior.
 */
export async function tratarAprovarProposta(
  req: Request,
  campaignId: string,
  deps: DepsPropostaHttp,
): Promise<Response> {
  const recusa = recusar(req, campaignId, deps.segredo);
  if (recusa) return recusa;

  const resultado = await aprovarPropostaDaCampanha({
    db: deps.db,
    tenantId: deps.tenantId,
    campaignId,
  });

  return resultado.aprovado
    ? json({ ok: true, cargos: resultado.cargos })
    : json({ erro: resultado.motivo }, 422);
}
