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
  /** Qual fornecedor rodou este lote. */
  provedor?: string;
  /** As causas mais frequentes, já contadas. Vazio quando não houve falha. */
  motivos_das_falhas?: string;
  /** O que cada fonte respondeu, contado — inclui o texto do erro. */
  fontes_das_falhas?: string;
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

  /**
   * O diagnóstico do lote, contado enquanto ele roda.
   *
   * A resposta do botão dizia só "N falhas", e a causa exigia abrir Ver
   * empresas e expandir linha por linha. Contar aqui põe a explicação no
   * mesmo lugar onde o operador já está olhando.
   */
  const motivos = new Map<string, number>();
  const porFonte = new Map<string, number>();
  const contar = (mapa: Map<string, number>, chave: string) => {
    mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
  };

  for (const empresa of pendentes) {
    try {
      const resultado = await enriquecerDecisor(
        {
          cnpj: empresa.cnpj,
          nomeDaEmpresa: empresa.trade_name?.trim() || empresa.legal_name.trim(),
          // O site cadastrado quando existe. Empresa vinda da Lusha traz
          // domínio aqui; empresa da Receita chega sem, e a cadeia deriva do
          // e-mail declarado ou cai na razão social.
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
          // O motivo em uma frase, ao lado das tentativas cruas. `tentativas`
          // serve para medir fornecedor; isto serve para o operador ler na
          // tela por que ESTA empresa ficou sem decisor, sem precisar
          // interpretar a lista de fontes.
          motivo: resultado.achou ? null : resultado.motivo,
          tentativas: resultado.tentativas,
        },
      });

      if (!resultado.achou) {
        await marcarEnriquecimento(db, tenantId, empresa.id, "failed");
        falhas += 1;

        /**
         * Guarda o motivo e o que cada fonte respondeu, para o resumo do lote.
         *
         * Sem isto, a resposta do botão é "20 falhas" e a causa só aparece
         * clicando em Ver empresas e abrindo linha por linha. Custou várias
         * rodadas de diagnóstico às cegas — a informação existia e estava a
         * dois cliques de distância de quem precisava dela.
         */
        contar(motivos, resultado.motivo);
        for (const tentativa of resultado.tentativas) {
          const rotulo =
            `${tentativa.fonte} · ${tentativa.resultado}` +
            (tentativa.resultado === "erro" && tentativa.detalhe
              ? `: ${tentativa.detalhe}`
              : "");
          contar(porFonte, rotulo);
        }
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
      const mensagemDoErro = erro instanceof Error ? erro.message : String(erro);
      contar(motivos, "Exceção durante o enriquecimento.");
      contar(porFonte, "exceção: " + mensagemDoErro);
      falhas += 1;
      await registrarEvento(db, {
        tenantId,
        leadId: null,
        kind: "falha_no_enriquecimento",
        payload: {
          companyId: empresa.id,
          erro: mensagemDoErro,
        },
      }).catch(() => {
        // Igual ao padrão do lote de envio: se nem o evento grava, o banco
        // está fora, e a próxima empresa do lote segue mesmo assim.
      });
    }
  }

  /** As três causas mais frequentes, da mais comum para a menos. */
  const maisComuns = (mapa: Map<string, number>): string =>
    [...mapa.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([chave, quantas]) => `${chave} (${quantas})`)
      .join("; ");

  const diagnostico = falhas > 0 ? maisComuns(porFonte) : "";

  return {
    processadas: pendentes.length,
    encontrados,
    falhas,
    provedor: provedor.nome,
    motivos_das_falhas: maisComuns(motivos),
    fontes_das_falhas: diagnostico,
    motivo:
      `Processadas ${pendentes.length}, ${encontrados} decisor(es) encontrado(s), ` +
      `${falhas} falha(s) via ${provedor.nome}.` +
      (diagnostico ? ` Principal causa: ${diagnostico}` : ""),
  };
}
