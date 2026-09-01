import type { Db } from "../db/port.js";
import { buscarCampanha } from "../db/repositories/campaigns.js";
import {
  salvarEmpresas,
  salvarEmpresasExternas,
} from "../db/repositories/companies.js";
import { registrarEvento } from "../db/repositories/events.js";
import { NicheFiltersSchema, type NicheFilters } from "../ai/niche-parser.js";
import {
  pesquisarEmpresas,
  temFiltroUtil,
  type EmpresaEncontrada,
} from "./casa-dos-dados.js";
import type { FetchLike } from "../http/fetch-json.js";
import {
  pesquisarEmpresasNaLusha,
  temFiltroDeEmpresaUtil,
} from "./lusha-empresas.js";
import { semSegredos } from "../config/redigir.js";

export interface ResultadoDaDescoberta {
  encontradas: number;
  salvas: number;
  ignoradas: number;
  paginas: number;
  /** A mensagem do fornecedor quando a busca falhou. Ausente no caminho feliz. */
  erro?: string;
  motivo: string;
}

const TAMANHO_DA_PAGINA = 100;

/** Páginas grandes: a cota da Lusha é diária e dividida com o enriquecimento. */
const PAGINA_DA_LUSHA = 50;

/**
 * Busca empresas na Casa dos Dados a partir do filtro já salvo da campanha
 * (gerado pelo `parseNiche` a partir da descrição em texto livre) e grava as
 * novas na tabela `companies`, prontas para o lote de enriquecimento.
 *
 * Pagina até esgotar os resultados ou atingir `maxEmpresas` — o que vier
 * primeiro. `maxEmpresas` é um teto por chamada, não da campanha inteira: o
 * n8n reagenda esta rota, e cada CNPJ já salvo é ignorado pelo `on conflict`
 * de `salvarEmpresas`, então rodar de novo amanhã só busca o que ainda não
 * apareceu.
 */
export async function descobrirEmpresas(
  input: {
    db: Db;
    tenantId: string;
    campaignId: string;
    apiKey: string;
    /** `LUSHA_API_KEY`. Preenchida, a descoberta passa a ser dela. */
    apiKeyLusha?: string;
    maxEmpresas?: number;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<ResultadoDaDescoberta> {
  const { db, tenantId, campaignId, apiKey, maxEmpresas = 300 } = input;
  const apiKeyLusha = (input.apiKeyLusha ?? "").trim();
  const vazio = { encontradas: 0, salvas: 0, ignoradas: 0, paginas: 0 };

  const campanha = await buscarCampanha(db, tenantId, campaignId);
  if (!campanha) {
    return { ...vazio, motivo: "Campanha não encontrada." };
  }

  const filtros = NicheFiltersSchema.safeParse(campanha.filters);
  if (!filtros.success) {
    return {
      ...vazio,
      motivo: "Campanha sem filtros de nicho salvos (rode o parseNiche antes).",
    };
  }

  /**
   * Com chave da Lusha, a descoberta é dela. Sem, cai na Casa dos Dados.
   *
   * A troca resolve o casamento entre as duas bases: descobrir na Receita e
   * perguntar à Lusha pela razão social devolvia vazio em 100 de 100 empresas,
   * porque ela não indexa `INDUSTRIA XYZ LTDA`. Descobrindo aqui, a empresa já
   * vem com o id do grafo dela e com domínio.
   */
  if (apiKeyLusha) {
    return descobrirNaLusha(
      { db, tenantId, campaignId, apiKey: apiKeyLusha, maxEmpresas },
      filtros.data,
      deps,
    );
  }

  if (!temFiltroUtil(filtros.data)) {
    return {
      ...vazio,
      motivo:
        "Nicho sem CNAE, UF ou cidade reconhecidos: buscar sem filtro devolveria o Brasil inteiro.",
    };
  }
  let encontradas = 0;
  let salvas = 0;
  let ignoradas = 0;
  let pagina = 1;

  while (encontradas < maxEmpresas) {
    let lote: readonly EmpresaEncontrada[];
    try {
      const resposta = await pesquisarEmpresas(
        filtros.data,
        { apiKey, pagina, limite: TAMANHO_DA_PAGINA },
        deps,
      );
      lote = resposta.empresas;
    } catch (erro) {
      // Falha de rede/API no meio da paginação: para aqui e devolve o que já
      // foi salvo. A próxima chamada agendada retoma — não há como pedir
      // "continue da página X" de novo com segurança, porque resultados
      // novos podem ter entrado na base da Casa dos Dados entre uma chamada
      // e outra e deslocado a paginação.
      const bruto = erro instanceof Error ? erro.message : String(erro);

      /**
       * O erro vai junto do motivo, e não só para `events`.
       *
       * Antes ficava só no evento, e a tela dizia "falha na busca" — que não
       * distingue chave inválida de fornecedor fora do ar, e manda o operador
       * abrir o banco para descobrir qual dos dois. Passa por `semSegredos`
       * porque a mensagem do HttpError carrega o corpo da resposta, e resposta
       * de erro de API às vezes ecoa a credencial recebida.
       */
      const mensagem = semSegredos(bruto);

      await registrarEvento(db, {
        tenantId,
        leadId: null,
        kind: "falha_na_descoberta",
        payload: { campaignId, pagina, erro: mensagem },
      }).catch(() => {});

      return {
        encontradas,
        salvas,
        ignoradas,
        paginas: pagina - 1,
        erro: mensagem,
        motivo:
          `Interrompida na página ${pagina} por falha na busca da Casa dos Dados; ` +
          `${salvas} salva(s) até aqui. Erro: ${mensagem}`,
      };
    }

    if (lote.length === 0) break;

    encontradas += lote.length;
    const resultado = await salvarEmpresas(
      db,
      lote.map((empresa) => ({
        tenantId,
        campaignId,
        cnpj: empresa.cnpj,
        legalName: empresa.razaoSocial,
        tradeName: empresa.nomeFantasia,
        // A busca avançada não devolve site nem quantidade de funcionários —
        // ambos ficam para o lote de enriquecimento (BrasilAPI/Hunter), que
        // já lida com a ausência deles.
        website: null,
        city: empresa.municipio,
        uf: empresa.uf,
        employeeCount: null,
        summary: null,
        source: "casa_dos_dados",
      })),
    );
    salvas += resultado.inseridas;
    ignoradas += resultado.ignoradas;

    if (lote.length < TAMANHO_DA_PAGINA) break;
    pagina += 1;
  }

  await registrarEvento(db, {
    tenantId,
    leadId: null,
    kind: "tentativa_de_descoberta",
    payload: { campaignId, encontradas, salvas, ignoradas, paginas: pagina },
  });

  return {
    encontradas,
    salvas,
    ignoradas,
    paginas: pagina,
    motivo: `${encontradas} encontrada(s) na Casa dos Dados, ${salvas} nova(s) salva(s), ${ignoradas} já existente(s).`,
  };
}

/**
 * Descoberta pela Lusha: busca paginada, empresas com id e domínio próprios.
 *
 * Páginas grandes de propósito. A cota da Lusha é diária e baixa (100 no
 * plano base), e ela é compartilhada com o enriquecimento — que gasta uma
 * chamada POR EMPRESA. Trazer 50 por chamada aqui deixa a cota para onde ela
 * é cara.
 */
async function descobrirNaLusha(
  input: {
    db: Db;
    tenantId: string;
    campaignId: string;
    apiKey: string;
    maxEmpresas: number;
  },
  filtros: NicheFilters,
  deps: { fetch?: FetchLike },
): Promise<ResultadoDaDescoberta> {
  const { db, tenantId, campaignId, apiKey, maxEmpresas } = input;
  const vazio = { encontradas: 0, salvas: 0, ignoradas: 0, paginas: 0 };

  if (!temFiltroDeEmpresaUtil(filtros)) {
    return {
      ...vazio,
      motivo:
        "Nicho sem setor, tecnologia ou porte para a Lusha. Rode Gerar filtros de novo: " +
        "os filtros salvos são de uma versão anterior, que só produzia CNAE e UF.",
    };
  }

  let encontradas = 0;
  let salvas = 0;
  let ignoradas = 0;
  let pagina = 0;

  while (encontradas < maxEmpresas) {
    let lote;
    try {
      lote = await pesquisarEmpresasNaLusha(
        filtros,
        // A página acompanha o teto: pedir 1 empresa não pode trazer 50.
        { apiKey, pagina, limite: Math.min(PAGINA_DA_LUSHA, maxEmpresas) },
        deps,
      );
    } catch (erro) {
      const mensagem = semSegredos(
        erro instanceof Error ? erro.message : String(erro),
      );
      await registrarEvento(db, {
        tenantId,
        leadId: null,
        kind: "falha_na_descoberta",
        payload: { campaignId, pagina, fornecedor: "lusha", erro: mensagem },
      }).catch(() => {});

      return {
        encontradas,
        salvas,
        ignoradas,
        paginas: pagina,
        erro: mensagem,
        motivo:
          `Interrompida na página ${pagina + 1} por falha na busca da Lusha; ` +
          `${salvas} salva(s) até aqui. Erro: ${mensagem}`,
      };
    }

    if (lote.empresas.length === 0) break;

    encontradas += lote.empresas.length;
    const resultado = await salvarEmpresasExternas(
      db,
      lote.empresas.map((e) => ({
        tenantId,
        campaignId,
        externalId: e.externalId,
        legalName: e.nome,
        // O domínio é o que faz a busca de contato funcionar depois. Guardado
        // em `website` porque é de lá que `dominioDoSite` já lê.
        website: e.dominio,
        city: e.cidade,
        uf: e.uf,
        employeeCount: e.funcionarios,
        summary: e.setor,
        source: "lusha",
      })),
    );
    salvas += resultado.inseridas;
    ignoradas += resultado.ignoradas;

    if (lote.empresas.length < Math.min(PAGINA_DA_LUSHA, maxEmpresas)) break;
    pagina += 1;
  }

  await registrarEvento(db, {
    tenantId,
    leadId: null,
    kind: "tentativa_de_descoberta",
    payload: {
      campaignId,
      fornecedor: "lusha",
      encontradas,
      salvas,
      ignoradas,
      paginas: pagina + 1,
    },
  }).catch(() => {});

  return {
    encontradas,
    salvas,
    ignoradas,
    paginas: pagina + 1,
    motivo: `${encontradas} encontrada(s) na Lusha, ${salvas} nova(s) salva(s), ${ignoradas} já existente(s).`,
  };
}
