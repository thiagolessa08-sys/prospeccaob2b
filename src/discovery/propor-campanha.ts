import type { Db } from "../db/port.js";
import {
  buscarCampanha,
  salvarProposta,
  aprovarProposta,
} from "../db/repositories/campaigns.js";
import { registrarEvento } from "../db/repositories/events.js";
import { proporCampanha, type Proposta } from "../ai/proposta.js";

export interface DepsProporCampanha {
  proporCampanha: typeof proporCampanha;
}

const DEPS_PADRAO: DepsProporCampanha = { proporCampanha };

export type ResultadoDaProposta =
  | { proposto: true; proposta: Proposta }
  | { proposto: false; motivo: string };

/**
 * Pede à IA a campanha inteira a partir do propósito da solução, e guarda
 * como rascunho.
 *
 * Rota própria, separada da criação da campanha, pelo mesmo motivo de
 * `gerarFiltros`: se a chamada à IA falhar, dá para tentar de novo sozinha,
 * sem recriar a campanha nem perder o que já foi gravado dela. E como o
 * resultado é rascunho, pedir de novo não estraga nada — sobrescreve uma
 * proposta que ninguém aprovou.
 */
export async function proporParaRevisao(
  input: { db: Db; tenantId: string; campaignId: string },
  deps: DepsProporCampanha = DEPS_PADRAO,
): Promise<ResultadoDaProposta> {
  const { db, tenantId, campaignId } = input;

  const campanha = await buscarCampanha(db, tenantId, campaignId);
  if (!campanha) {
    return { proposto: false, motivo: "Campanha não encontrada." };
  }

  /**
   * Sem propósito escrito, usa a descrição do nicho.
   *
   * É o que permite propor para as campanhas criadas antes desta tela existir:
   * elas têm nicho e oferta escritos à mão e `solution_purpose` nulo. Sem esta
   * queda, o botão só funcionaria em campanha nova.
   */
  const proposito = campanha.solution_purpose?.trim() || campanha.niche_description;
  if (!proposito.trim()) {
    return {
      proposto: false,
      motivo: "A campanha não tem propósito nem descrição de nicho para propor.",
    };
  }

  try {
    const proposta = await deps.proporCampanha(proposito);
    await salvarProposta(db, tenantId, campaignId, proposta);
    return { proposto: true, proposta };
  } catch (erro) {
    const mensagemDeErro = erro instanceof Error ? erro.message : String(erro);
    await registrarEvento(db, {
      tenantId,
      leadId: null,
      kind: "falha_ao_propor_campanha",
      payload: { campaignId, erro: mensagemDeErro },
    }).catch(() => {});
    return {
      proposto: false,
      motivo: `Falha ao propor a campanha: ${mensagemDeErro}`,
    };
  }
}

export type ResultadoDaAprovacao =
  | { aprovado: true; cargos: readonly string[] }
  | { aprovado: false; motivo: string };

/**
 * Promove a proposta revisada a campanha de verdade.
 *
 * Aprova o que está gravado, e não o que veio na requisição: quem quer mudar
 * algo salva a edição antes. Assim o que foi aprovado é exatamente o que a
 * pessoa estava vendo na tela, e não um corpo de requisição que pode ter
 * divergido dela.
 */
export async function aprovarPropostaDaCampanha(input: {
  db: Db;
  tenantId: string;
  campaignId: string;
}): Promise<ResultadoDaAprovacao> {
  const { db, tenantId, campaignId } = input;

  const campanha = await buscarCampanha(db, tenantId, campaignId);
  if (!campanha) {
    return { aprovado: false, motivo: "Campanha não encontrada." };
  }
  if (!campanha.proposal) {
    return { aprovado: false, motivo: "Não há proposta para aprovar." };
  }

  const proposta = campanha.proposal as Proposta;

  await aprovarProposta(db, tenantId, campaignId, {
    nicho: proposta.nicho,
    oferta: proposta.oferta,
    briefing: proposta.briefing,
  });

  await registrarEvento(db, {
    tenantId,
    leadId: null,
    kind: "proposta_aprovada",
    payload: { campaignId, cargos: proposta.cargos },
  }).catch(() => {});

  /**
   * Os cargos voltam para quem chamou, e não são gravados em `filters` aqui.
   *
   * `filters` acabou de ser zerado pela aprovação — gravar `target_roles`
   * agora criaria um filtro pela metade, sem CNAE nem UF, que
   * `descobrirEmpresas` leria como alvo válido. Eles entram junto com o resto
   * quando `gerar-filtros` rodar sobre o nicho novo: de lá, `cargosAprovados`
   * relê esta mesma proposta e sobrepõe o que a IA do nicho tiver proposto.
   */
  return { aprovado: true, cargos: proposta.cargos };
}
