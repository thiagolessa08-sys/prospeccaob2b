import type { Db } from "../db/port.js";
import { buscarCampanha, salvarFiltros } from "../db/repositories/campaigns.js";
import { registrarEvento } from "../db/repositories/events.js";
import { parseNiche, type NicheFilters } from "../ai/niche-parser.js";

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
    await salvarFiltros(db, tenantId, campaignId, filtros);
    return { gerado: true, filtros };
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
