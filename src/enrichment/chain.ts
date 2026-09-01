import { buscarEmpresaPorCnpj } from "./brasilapi.js";
import { acharEmailPorNome, buscarNoDominio, verificarEmail } from "./hunter.js";
import { ehEmailGenerico } from "./generic-emails.js";
import { dominioDoEmail } from "./dominio.js";
import type {
  CandidatoDecisor,
  DadosDaEmpresa,
  FonteDoDecisor,
  StatusVerificacao,
} from "./types.js";

/**
 * Quem estamos procurando. A escolha muda a cadeia inteira: o quadro societário
 * do CNPJ entrega sócios e administradores de graça, o que resolve o caso da
 * PME — mas não serve para achar um "Gerente de TI" numa empresa de 500
 * pessoas, onde só a busca por domínio funciona.
 */
export type AlvoDaCampanha =
  | { tipo: "socio_ou_dono" }
  | {
      tipo: "cargo_funcional";
      /** Departamento no vocabulário da Hunter (`finance`, `it`, `operations`). */
      departamento: string;
      senioridade?: string;
      /**
       * Os cargos como a campanha os escreveu, em português.
       *
       * Viajam ao lado do departamento porque os dois fornecedores querem
       * coisas diferentes: a Hunter filtra por uma lista fechada de
       * departamentos em inglês, e a Lusha filtra por título de cargo em
       * texto livre. Mandar a sigla da Hunter como título para a Lusha
       * procura literalmente por "finance", que não casa com ninguém.
       */
      cargos: readonly string[];
    };

export interface TentativaDeFonte {
  fonte: FonteDoDecisor;
  resultado: "acertou" | "vazio" | "generico" | "nao_verificado" | "erro";
  detalhe?: string;
}

export type ResultadoEnriquecimento =
  | { achou: true; candidato: CandidatoDecisor; tentativas: readonly TentativaDeFonte[] }
  | { achou: false; motivo: string; tentativas: readonly TentativaDeFonte[] };

export interface EntradaEnriquecimento {
  cnpj: string;
  dominio: string | null;
  apiKey: string;
  alvo: AlvoDaCampanha;
}

export interface DepsEnriquecimento {
  buscarEmpresa: typeof buscarEmpresaPorCnpj;
  acharPorNome: typeof acharEmailPorNome;
  buscarDominio: typeof buscarNoDominio;
  verificar: typeof verificarEmail;
}

const DEPS_PADRAO: DepsEnriquecimento = {
  buscarEmpresa: buscarEmpresaPorCnpj,
  acharPorNome: acharEmailPorNome,
  buscarDominio: buscarNoDominio,
  verificar: verificarEmail,
};

/** `accept_all` é indeterminado, não reprovado — o domínio aceita tudo. */
function verificacaoAprova(status: StatusVerificacao): boolean {
  return status === "valid" || status === "accept_all";
}

function separarNome(completo: string): { primeiro: string; ultimo: string } | null {
  const partes = completo.trim().split(/\s+/).filter(Boolean);
  if (partes.length < 2) return null;
  return { primeiro: partes[0]!, ultimo: partes[partes.length - 1]! };
}

/**
 * Procura o decisor de uma empresa, das fontes gratuitas para as pagas.
 *
 * Devolve sempre a lista de tentativas, com o que cada fonte respondeu. Isso é
 * deliberado: nenhum fornecedor publica taxa de acerto para o Brasil, então a
 * única forma de saber se a Hunter vale o custo aqui é medir. Quem chama deve
 * gravar `tentativas` em `events`.
 */
export async function enriquecerDecisor(
  entrada: EntradaEnriquecimento,
  deps: DepsEnriquecimento = DEPS_PADRAO,
): Promise<ResultadoEnriquecimento> {
  const tentativas: TentativaDeFonte[] = [];

  let empresa: DadosDaEmpresa | null;
  try {
    empresa = await deps.buscarEmpresa(entrada.cnpj);
  } catch (erro) {
    tentativas.push({
      fonte: "cnpj_qsa",
      resultado: "erro",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return { achou: false, motivo: "Falha ao consultar o CNPJ.", tentativas };
  }

  if (!empresa) {
    tentativas.push({ fonte: "cnpj_qsa", resultado: "vazio" });
    return { achou: false, motivo: "Empresa não encontrada pelo CNPJ.", tentativas };
  }

  // Empresa baixada, suspensa ou inapta não recebe prospecção — e checar isso
  // antes de qualquer chamada paga evita queimar crédito à toa.
  if (!empresa.ativa) {
    tentativas.push({ fonte: "cnpj_qsa", resultado: "vazio", detalhe: "situação cadastral não é ATIVA" });
    return { achou: false, motivo: "Empresa com situação cadastral inativa.", tentativas };
  }

  // 1. E-mail do próprio registro da Receita, se for de pessoa.
  if (empresa.email) {
    if (ehEmailGenerico(empresa.email)) {
      tentativas.push({ fonte: "cnpj_email", resultado: "generico", detalhe: empresa.email });
    } else {
      const candidato: CandidatoDecisor = {
        nome: empresa.socios[0]?.nome ?? null,
        cargo: empresa.socios[0]?.qualificacao ?? null,
        email: empresa.email,
        // Sintético: a Receita não dá score. 70 reflete "endereço declarado
        // pela própria empresa, mas pode estar desatualizado".
        confianca: 70,
        verificacao: "unknown",
        fonte: "cnpj_email",
      };
      const aprovado = await verificarComTolerancia(candidato, entrada.apiKey, deps, tentativas);
      if (aprovado) return { achou: true, candidato: aprovado, tentativas };
    }
  }

  // Como a Hunter vai saber de que empresa estamos falando. Três níveis, do
  // mais preciso ao mais frouxo:
  //
  //   1. o site cadastrado, quando existe;
  //   2. o domínio do e-mail que a empresa declarou à Receita — serve mesmo
  //      sendo caixa genérica: `contato@empresa.com.br` não presta como
  //      destinatário, mas revela o domínio;
  //   3. a razão social, que a Hunter aceita no lugar do domínio.
  //
  // Sem o nível 3 o funil não fecharia: a busca avançada da Casa dos Dados
  // não devolve site nenhum, e boa parte dos CNPJs não tem e-mail na Receita —
  // então a maioria das empresas descobertas chegaria aqui sem forma alguma
  // de procurar o decisor.
  const dominio = entrada.dominio ?? dominioDoEmail(empresa.email);
  const nomeDaEmpresa = empresa.nomeFantasia?.trim() || empresa.razaoSocial.trim();
  const localizador: { dominio?: string; empresa?: string } = dominio
    ? { dominio }
    : { empresa: nomeDaEmpresa };

  if (!dominio && !nomeDaEmpresa) {
    tentativas.push({
      fonte: "hunter_finder",
      resultado: "vazio",
      detalhe: "empresa sem site, sem e-mail na Receita e sem razão social",
    });
    return { achou: false, motivo: "Sem forma de localizar a empresa.", tentativas };
  }

  // 2. Nome do sócio (grátis) + email-finder (pago) — acerta muito mais que a
  //    busca cega por domínio, pelo mesmo crédito.
  if (entrada.alvo.tipo === "socio_ou_dono") {
    for (const socio of empresa.socios) {
      const nome = separarNome(socio.nome);
      if (!nome) continue;
      try {
        const achado = await deps.acharPorNome({
          ...localizador,
          primeiroNome: nome.primeiro,
          sobrenome: nome.ultimo,
          apiKey: entrada.apiKey,
        });
        if (!achado?.email) {
          tentativas.push({ fonte: "hunter_finder", resultado: "vazio", detalhe: socio.nome });
          continue;
        }
        if (ehEmailGenerico(achado.email)) {
          tentativas.push({ fonte: "hunter_finder", resultado: "generico", detalhe: achado.email });
          continue;
        }
        const comCargo: CandidatoDecisor = {
          ...achado,
          cargo: achado.cargo ?? socio.qualificacao,
        };
        const aprovado = await verificarComTolerancia(comCargo, entrada.apiKey, deps, tentativas);
        if (aprovado) return { achou: true, candidato: aprovado, tentativas };
      } catch (erro) {
        tentativas.push({
          fonte: "hunter_finder",
          resultado: "erro",
          detalhe: erro instanceof Error ? erro.message : String(erro),
        });
      }
    }
  }

  // 3. Busca por domínio filtrada por cargo. Único caminho quando o alvo é
  //    funcional, e último recurso quando o sócio não deu em nada.
  try {
    const encontrados = await deps.buscarDominio({
      ...localizador,
      departamento:
        entrada.alvo.tipo === "cargo_funcional" ? entrada.alvo.departamento : undefined,
      senioridade:
        entrada.alvo.tipo === "cargo_funcional" ? entrada.alvo.senioridade : undefined,
      // Os cargos em português, para quem filtra por título em vez de por
      // departamento. Quem não usa, ignora.
      cargos:
        entrada.alvo.tipo === "cargo_funcional" ? entrada.alvo.cargos : undefined,
      apiKey: entrada.apiKey,
    });

    const pessoais = encontrados.filter((c) => c.email && !ehEmailGenerico(c.email));
    const descartados = encontrados.length - pessoais.length;
    if (descartados > 0) {
      tentativas.push({
        fonte: "hunter_domain",
        resultado: "generico",
        detalhe: `${descartados} caixa(s) compartilhada(s) descartada(s)`,
      });
    }

    if (pessoais.length === 0) {
      if (encontrados.length === 0) {
        tentativas.push({ fonte: "hunter_domain", resultado: "vazio" });
      }
    } else {
      const melhor = [...pessoais].sort((a, b) => b.confianca - a.confianca)[0]!;
      const aprovado = await verificarComTolerancia(melhor, entrada.apiKey, deps, tentativas);
      if (aprovado) return { achou: true, candidato: aprovado, tentativas };
    }
  } catch (erro) {
    tentativas.push({
      fonte: "hunter_domain",
      resultado: "erro",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
  }

  return { achou: false, motivo: "Nenhum decisor com e-mail utilizável.", tentativas };
}

/**
 * Verifica o e-mail antes de aceitar o candidato. Uma falha da verificação não
 * derruba a cadeia: registra e recusa aquele candidato, deixando a próxima
 * fonte tentar.
 */
async function verificarComTolerancia(
  candidato: CandidatoDecisor,
  apiKey: string,
  deps: DepsEnriquecimento,
  tentativas: TentativaDeFonte[],
): Promise<CandidatoDecisor | null> {
  if (!candidato.email) return null;

  let status: StatusVerificacao;
  if (candidato.verificacao !== "unknown") {
    // A própria Hunter já embute uma verificação na resposta do finder e do
    // domain-search. Chamar o /email-verifier de novo gastaria um segundo
    // crédito só para confirmar o que a fonte já respondeu. Só o e-mail da
    // Receita chega aqui como "unknown" — sem verificação própria — e precisa
    // mesmo da chamada paga.
    status = candidato.verificacao;
  } else {
    try {
      const r = await deps.verificar({ email: candidato.email, apiKey });
      status = r.status;
    } catch (erro) {
      tentativas.push({
        fonte: candidato.fonte,
        resultado: "erro",
        detalhe: erro instanceof Error ? erro.message : String(erro),
      });
      return null;
    }
  }

  if (!verificacaoAprova(status)) {
    tentativas.push({
      fonte: candidato.fonte,
      resultado: "nao_verificado",
      detalhe: `verificação devolveu ${status}`,
    });
    return null;
  }

  tentativas.push({ fonte: candidato.fonte, resultado: "acertou" });
  return { ...candidato, verificacao: status };
}
