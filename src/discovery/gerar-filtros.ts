import type { Db } from "../db/port.js";
import { buscarCampanha, salvarFiltros } from "../db/repositories/campaigns.js";
import { registrarEvento } from "../db/repositories/events.js";
import { parseNiche, type NicheFilters } from "../ai/niche-parser.js";
import type { Campaign } from "../db/types.js";

export interface DepsGerarFiltros {
  parseNiche: typeof parseNiche;
}

const DEPS_PADRAO: DepsGerarFiltros = { parseNiche };

export type ResultadoDeGerarFiltros =
  | { gerado: true; filtros: NicheFilters }
  | { gerado: false; motivo: string };

/**
 * Converte a descrição em texto livre do nicho da campanha (a que
 * `criarCampanha` já salvou) em filtros estruturados via IA, e grava em
 * `campaigns.filters` — de onde `descobrirEmpresas` e `enriquecerLote` os
 * leem depois.
 *
 * Rota própria, separada da criação da campanha: se a chamada à IA falhar,
 * dá para tentar de novo sozinha, sem recriar a campanha nem perder o que já
 * foi gravado dela.
 */
export async function gerarFiltros(
  input: { db: Db; tenantId: string; campaignId: string },
  deps: DepsGerarFiltros = DEPS_PADRAO,
): Promise<ResultadoDeGerarFiltros> {
  const { db, tenantId, campaignId } = input;

  const campanha = await buscarCampanha(db, tenantId, campaignId);
  if (!campanha) {
    return { gerado: false, motivo: "Campanha não encontrada." };
  }

  try {
    const filtros = await deps.parseNiche(campanha.niche_description);

    /**
     * Os cargos aprovados na proposta vencem os que a IA derivou do nicho.
     *
     * `parseNiche` lê só a descrição do nicho e propõe cargos por conta
     * própria. Se ela sobrescrevesse a proposta, a tela de refino seria
     * teatro: a pessoa editaria "Diretor Industrial" e o funil sairia
     * procurando o que o outro prompt achou melhor. Vale só quando há
     * aprovação — proposta em rascunho não manda em nada.
     */
    const cargos = cargosAprovados(campanha);
    const finais = cargos ? { ...filtros, target_roles: cargos } : filtros;

    await salvarFiltros(db, tenantId, campaignId, finais);
    return { gerado: true, filtros: finais };
  } catch (erro) {
    const mensagemDeErro = erro instanceof Error ? erro.message : String(erro);
    await registrarEvento(db, {
      tenantId,
      leadId: null,
      kind: "falha_ao_gerar_filtros",
      payload: { campaignId, erro: mensagemDeErro },
    }).catch(() => {});
    return {
      gerado: false,
      motivo: `Falha ao gerar filtros a partir do nicho: ${mensagemDeErro}`,
    };
  }
}

/**
 * Os cargos da proposta aprovada, se houver.
 *
 * `proposal` é `jsonb` e chega como `unknown` — checar a forma aqui evita que
 * um rascunho antigo, ou uma proposta gravada por uma versão anterior do
 * schema, derrube a geração de filtros com erro de tipo em tempo de execução.
 */
function cargosAprovados(campanha: Campaign): string[] | null {
  if (!campanha.proposal_approved_at) return null;

  const proposta = campanha.proposal as { cargos?: unknown } | null;
  const cargos = proposta?.cargos;
  if (!Array.isArray(cargos)) return null;

  const limpos = cargos.filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0,
  );
  return limpos.length > 0 ? limpos : null;
}
