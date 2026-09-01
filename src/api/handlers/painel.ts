import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { UUID_DO_POSTGRES } from "../../config/env.js";
import { listarCampanhas } from "../../db/repositories/campaigns.js";
import {
  contarEmpresasPorStatus,
  listarEmpresasDaCampanha,
} from "../../db/repositories/companies.js";
import {
  buscarLead,
  contarLeadsPorEstagio,
  listarLeadsDaCampanha,
} from "../../db/repositories/leads.js";
import { carregarConversa } from "../../db/repositories/messages.js";
import {
  listarEventosDoLead,
  listarEventosDaCampanha,
} from "../../db/repositories/events.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsPainelHttp {
  db: Db;
  tenantId: string;
  segredo: string;
  /** Como o painel anuncia o fornecedor de enriquecimento em uso. */
  provedorDeEnriquecimento: string;
}

/** Teto de linhas por página do painel. Ninguém lê mil leads numa tela. */
const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 500;
const EVENTOS_POR_LEAD = 50;

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function limiteDaQuery(req: Request): number {
  const bruto = new URL(req.url).searchParams.get("limite");
  const pedido = Number(bruto);
  if (!Number.isFinite(pedido) || pedido <= 0) return LIMITE_PADRAO;
  return Math.min(Math.trunc(pedido), LIMITE_MAXIMO);
}

/**
 * Recusa id que o Postgres não aceitaria como `uuid`.
 *
 * Sem isto, `/painel/leads/foo` vira exceção do driver — 500 e uma linha de
 * stack no log — em vez de 400. É uma URL que qualquer um digita errado, e um
 * 500 aqui mandaria o operador caçar defeito de servidor onde só há id torto.
 */
function idInvalido(id: string): Response | null {
  if (UUID_DO_POSTGRES.test(id)) return null;
  return json({ erro: "id não é um uuid válido" }, 400);
}

/**
 * Resumo de todas as campanhas: o que cada uma tem de empresa e de lead.
 *
 * As contagens são feitas em SQL, uma consulta por campanha, e não trazendo as
 * linhas para contar em memória — uma campanha madura tem milhares de empresas
 * e o painel precisa abrir em qualquer tamanho de base.
 */
export async function tratarResumoDoPainel(
  req: Request,
  deps: DepsPainelHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const campanhas = await listarCampanhas(deps.db, deps.tenantId);

  const resumo = await Promise.all(
    campanhas.map(async (campanha) => {
      const [empresas, leads] = await Promise.all([
        contarEmpresasPorStatus(deps.db, deps.tenantId, campanha.id),
        contarLeadsPorEstagio(deps.db, deps.tenantId, campanha.id),
      ]);
      return {
        id: campanha.id,
        name: campanha.name,
        status: campanha.status,
        send_mode: campanha.send_mode,
        niche_description: campanha.niche_description,
        daily_send_limit: campanha.daily_send_limit,
        /**
         * Os filtros inteiros, e não mais só "tem ou não tem".
         *
         * A tela precisa mostrar QUAIS filtros foram gerados: um botão que
         * responde "pronto" sem dizer o que fez obriga a abrir o banco para
         * conferir. São poucos campos — CNAEs, UFs, cidades, porte, cargos e
         * palavras-chave.
         */
        filtros: campanha.filters,
        tem_filtros: campanha.filters !== null,
        provedor_de_enriquecimento: deps.provedorDeEnriquecimento,
        tem_proposta: campanha.proposal !== null,
        proposta_aprovada_em: campanha.proposal_approved_at,
        /**
         * A proposta inteira vai junto, ao contrário dos filtros.
         *
         * É o que o editor de refino carrega, e são poucos KB por campanha.
         * Uma rota separada só para ela custaria uma ida a mais ao servidor
         * toda vez que alguém abre a proposta — e o painel já busca esta
         * lista a cada ação de lote, então ela estaria sempre fresca aqui.
         */
        proposta: campanha.proposal,
        created_at: campanha.created_at,
        empresas,
        leads,
      };
    }),
  );

  return json(resumo);
}

/** Leads de uma campanha, já com o nome da empresa. */
export async function tratarLeadsDaCampanha(
  req: Request,
  campaignId: string,
  deps: DepsPainelHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const recusa = idInvalido(campaignId);
  if (recusa) return recusa;

  const leads = await listarLeadsDaCampanha(
    deps.db,
    deps.tenantId,
    campaignId,
    limiteDaQuery(req),
  );
  return json(leads);
}

/**
 * Um lead com a conversa e a trilha de eventos.
 *
 * É a tela que responde "por que este lead parou aqui?" — sem ela, a resposta
 * só existe no banco, e o operador não tem como saber se um lead em
 * `needs_human` está esperando alguém há uma hora ou há uma semana.
 */
export async function tratarDetalheDoLead(
  req: Request,
  leadId: string,
  deps: DepsPainelHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const recusa = idInvalido(leadId);
  if (recusa) return recusa;

  const lead = await buscarLead(deps.db, deps.tenantId, leadId);
  if (!lead) {
    return json({ erro: "lead não encontrado" }, 404);
  }

  const [conversa, eventos] = await Promise.all([
    carregarConversa(deps.db, deps.tenantId, leadId),
    listarEventosDoLead(deps.db, deps.tenantId, leadId, EVENTOS_POR_LEAD),
  ]);

  return json({ lead, conversa, eventos });
}

/**
 * Empresas descobertas, com o motivo de cada uma que ficou sem decisor.
 *
 * Faltava a metade do meio do funil. Depois de `descobrir-empresas` havia um
 * número e nada mais: nenhuma forma de ver quais empresas entraram, nem por
 * que o enriquecimento desistiu de algumas. `Ver leads` só mostra quem já
 * virou lead — ou seja, exatamente as que deram certo.
 */
export async function tratarEmpresasDaCampanha(
  req: Request,
  campaignId: string,
  deps: DepsPainelHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const recusa = idInvalido(campaignId);
  if (recusa) return recusa;

  const empresas = await listarEmpresasDaCampanha(
    deps.db,
    deps.tenantId,
    campaignId,
    limiteDaQuery(req),
  );
  return json(empresas);
}

/**
 * A trilha da campanha: falha ao propor, ao gerar filtros, ao descobrir.
 *
 * Esses eventos nascem com `lead_id` nulo — acontecem antes de existir lead —
 * e por isso não apareciam em lugar nenhum. Foi o que fez uma falha na busca
 * da Casa dos Dados virar um "falha na busca" sem causa na tela, com o motivo
 * real gravado no banco e invisível.
 */
export async function tratarEventosDaCampanha(
  req: Request,
  campaignId: string,
  deps: DepsPainelHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  const recusa = idInvalido(campaignId);
  if (recusa) return recusa;

  const eventos = await listarEventosDaCampanha(
    deps.db,
    deps.tenantId,
    campaignId,
    limiteDaQuery(req),
  );
  return json(eventos);
}
