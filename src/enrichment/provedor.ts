import { buscarEmpresaPorCnpj } from "./brasilapi.js";
import {
  acharEmailPorNome as hunterPorNome,
  buscarNoDominio as hunterPorDominio,
  verificarEmail as hunterVerifica,
} from "./hunter.js";
import {
  acharEmailPorNome as lushaPorNome,
  buscarNoDominio as lushaPorDominio,
  verificarEmail as lushaVerifica,
} from "./lusha.js";
import type { DepsEnriquecimento } from "./chain.js";

export interface ChavesDeEnriquecimento {
  hunter: string;
  lusha: string;
}

export interface ProvedorEscolhido {
  nome: "lusha" | "hunter";
  deps: DepsEnriquecimento;
  /** A chave que vai na cadeia. Uma só, e tem que ser a do provedor certo. */
  apiKey: string;
}

/**
 * Escolhe quem procura o decisor.
 *
 * A Lusha entra no lugar da Hunter, não ao lado: a cadeia leva **uma** chave
 * de API, e misturar os dois faria a chave de um chegar no endpoint do outro.
 * Por isso a escolha é por presença de chave — `LUSHA_API_KEY` preenchida
 * manda; vazia, segue a Hunter, e nada muda para quem já está rodando.
 *
 * A descoberta de empresas não passa por aqui. Ela continua na Casa dos
 * Dados, que vem da Receita e traz CNPJ, CNAE e situação cadastral — dados
 * que a Lusha não tem e que o funil usa para recusar empresa inativa antes de
 * gastar crédito.
 */
export function escolherProvedor(
  chaves: ChavesDeEnriquecimento,
): ProvedorEscolhido {
  const lusha = chaves.lusha.trim();
  if (lusha) {
    return {
      nome: "lusha",
      apiKey: lusha,
      deps: {
        buscarEmpresa: buscarEmpresaPorCnpj,
        acharPorNome: lushaPorNome,
        buscarDominio: lushaPorDominio,
        verificar: lushaVerifica,
      },
    };
  }

  return {
    nome: "hunter",
    apiKey: chaves.hunter,
    deps: {
      buscarEmpresa: buscarEmpresaPorCnpj,
      acharPorNome: hunterPorNome,
      buscarDominio: hunterPorDominio,
      verificar: hunterVerifica,
    },
  };
}

/**
 * Como o painel descreve o fornecedor em uso, incluindo o caso sem chave.
 *
 * "hunter" com a chave vazia não é o padrão funcionando: é o sistema caindo
 * no fornecedor que ninguém configurou, e cada empresa vai falhar com 401
 * disfarçado de "nenhum decisor encontrado". A etiqueta precisa dizer isso na
 * cara, porque foi exatamente essa confusão que custou 20 empresas queimadas
 * e um diagnóstico inteiro apontando para o lado errado.
 */
export function descreverProvedor(chaves: ChavesDeEnriquecimento): string {
  const escolhido = escolherProvedor(chaves);
  return escolhido.apiKey.trim() ? escolhido.nome : `${escolhido.nome} (SEM CHAVE)`;
}
