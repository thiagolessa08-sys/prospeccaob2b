import type { Db } from "../db/port.js";
import { buscarCampanha } from "../db/repositories/campaigns.js";
import {
  listarPendentesDeEnriquecimento,
  marcarEnriquecimento,
} from "../db/repositories/companies.js";
import { criarLead } from "../db/repositories/leads.js";
import { registrarEvento } from "../db/repositories/events.js";
import { NicheFiltersSchema } from "../ai/niche-parser.js";
import { enriquecerDecisor, type DepsEnriquecimento } from "./chain.js";
import { paraNovoLead } from "./para-lead.js";
import { alvoDaCampanha } from "./alvo.js";
import { dominioDoSite } from "./dominio.js";
import { escolherProvedor } from "./provedor.js";

export interface ResultadoDoEnriquecimentoEmLote {
  processadas: number;
  encontrados: number;
  falhas: number;
  motivo: string;
}

/**
 * Enriquece as empresas pendentes de uma campanha: acha o decisor de cada
 * uma e cria o lead correspondente.
 *
 * `campaigns.filters` é lido de novo aqui, e não guardado como
 * `AlvoDaCampanha` já pronto, porque o filtro é gravado uma vez na criação da
 * campanha (Task de descoberta) e o alvo é derivado dele sempre que este lote
 * roda — sem duplicar a mesma decisão em dois lugares que podem divergir.
 */
export async function enriquecerLote(
  input: {
    db: Db;
    tenantId: string;
    campaignId: string;
    apiKeyHunter: string;
    /** `LUSHA_API_KEY`. Preenchida, a Lusha entra no lugar da Hunter. */
    apiKeyLusha?: string;
    limite?: number;
  },
  deps?: DepsEnriquecimento,
): Promise<ResultadoDoEnriquecimentoEmLote> {
  const { db, tenantId, campaignId, apiKeyHunter, limite = 20 } = input;

  /**
   * `deps` explícito vence a escolha por chave: é como os testes injetam
   * fornecedor falso, e uma variável de ambiente não pode sequestrar isso.
   */
  const provedor = escolherProvedor({
    hunter: apiKeyHunter,
    lusha: input.apiKeyLusha ?? "",
  });
  const depsDaCadeia = deps ?? provedor.deps;
  const apiKey = deps ? apiKeyHunter : provedor.apiKey;
  const vazio = { processadas: 0, encontrados: 0, falhas: 0 };

  const campanha = await buscarCampanha(db, tenantId, campaignId);
  if (!campanha) {
    return { ...vazio, motivo: "Campanha não encontrada." };
  }

  const filtros = NicheFiltersSchema.safeParse(campanha.filters);
  const alvo = alvoDaCampanha(filtros.success ? filtros.data.target_roles : []);

  const pendentes = await listarPendentesDeEnriquecimento(
    db,
    tenantId,
    campaignId,
    limite,
  );
  if (pendentes.length === 0) {
    return { ...vazio, motivo: "Nenhuma empresa pendente de enriquecimento." };
  }

  let encontrados = 0;
  let falhas = 0;

  for (const empresa of pendentes) {
    try {
      if (!empresa.cnpj) {
        // Sem CNPJ não há como consultar o quadro societário nem a situação
        // cadastral — a cadeia inteira depende dele. Descartada, não perdida
        // em silêncio: o motivo fica em `events`.
        await marcarEnriquecimento(db, tenantId, empresa.id, "failed");
        await registrarEvento(db, {
          tenantId,
          leadId: null,
          kind: "empresa_sem_cnpj",
          payload: { companyId: empresa.id },
        });
        falhas += 1;
        continue;
      }

      const resultado = await enriquecerDecisor(
        {
          cnpj: empresa.cnpj,
          dominio: dominioDoSite(empresa.website),
          apiKey,
          alvo,
        },
        depsDaCadeia,
      );

      // Sempre grava, ache ou não. É a única forma de medir a taxa de acerto
      // real no Brasil, já que nenhum fornecedor a publica.
      await registrarEvento(db, {
        tenantId,
        leadId: null,
        kind: "tentativa_de_enriquecimento",
        payload: {
          companyId: empresa.id,
          achou: resultado.achou,
          // Qual fornecedor produziu esta tentativa. Sem isto, os eventos de
          // Hunter e Lusha se misturam e a comparação de acerto e custo
          // entre os dois — o motivo de existir a troca — fica impossível.
          provedor: provedor.nome,
          tentativas: resultado.tentativas,
        },
      });

      if (!resultado.achou) {
        await marcarEnriquecimento(db, tenantId, empresa.id, "failed");
        falhas += 1;
        continue;
      }

      await criarLead(
        db,
        paraNovoLead(resultado.candidato, {
          tenantId,
          campaignId,
          companyId: empresa.id,
        }),
      );
      await marcarEnriquecimento(db, tenantId, empresa.id, "enriched");
      encontrados += 1;
    } catch (erro) {
      falhas += 1;
      await registrarEvento(db, {
        tenantId,
        leadId: null,
        kind: "falha_no_enriquecimento",
        payload: {
          companyId: empresa.id,
          erro: erro instanceof Error ? erro.message : String(erro),
        },
      }).catch(() => {
        // Igual ao padrão do lote de envio: se nem o evento grava, o banco
        // está fora, e a próxima empresa do lote segue mesmo assim.
      });
    }
  }

  return {
    processadas: pendentes.length,
    encontrados,
    falhas,
    motivo: `Processadas ${pendentes.length}, ${encontrados} decisor(es) encontrado(s), ${falhas} falha(s).`,
  };
}
