import { fetchJson, HttpError, type FetchLike } from "../http/fetch-json.js";
import type { DadosDaEmpresa, SocioOuAdmin } from "./types.js";

const BASE = "https://brasilapi.com.br/api/cnpj/v1";

/** Forma da resposta da BrasilAPI, verificada contra a API em 2026-08-31. */
interface RespostaBrasilApi {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  cnae_fiscal: number;
  cnae_fiscal_descricao: string;
  uf: string | null;
  municipio: string | null;
  porte: string | null;
  descricao_situacao_cadastral: string;
  email: string | null;
  ddd_telefone_1: string | null;
  qsa?: Array<{
    nome_socio: string;
    qualificacao_socio: string;
    data_entrada_sociedade: string;
  }>;
}

export function normalizarCnpj(cnpj: string): string {
  const digitos = cnpj.replace(/\D/g, "");
  if (digitos.length !== 14) {
    throw new Error(`CNPJ precisa ter 14 dígitos, recebi "${cnpj}".`);
  }
  return digitos;
}

/**
 * Consulta os dados públicos do CNPJ. Grátis e sem autenticação.
 *
 * Devolve `null` só quando o CNPJ não existe (404). Erro de servidor é
 * propagado: tratar uma indisponibilidade da API como "empresa inexistente"
 * descartaria leads bons silenciosamente.
 */
export async function buscarEmpresaPorCnpj(
  cnpj: string,
  deps: { fetch?: FetchLike } = {},
): Promise<DadosDaEmpresa | null> {
  const limpo = normalizarCnpj(cnpj);

  let bruto: RespostaBrasilApi;
  try {
    bruto = await fetchJson<RespostaBrasilApi>(`${BASE}/${limpo}`, {
      fetch: deps.fetch,
      timeoutMs: 15_000,
      tentativas: 2,
    });
  } catch (erro) {
    if (erro instanceof HttpError && erro.status === 404) return null;
    throw erro;
  }

  const socios: SocioOuAdmin[] = (bruto.qsa ?? []).map((s) => ({
    nome: s.nome_socio,
    qualificacao: s.qualificacao_socio,
  }));

  return {
    cnpj: limpo,
    razaoSocial: bruto.razao_social,
    nomeFantasia: bruto.nome_fantasia,
    cnaePrincipal: String(bruto.cnae_fiscal),
    descricaoCnae: bruto.cnae_fiscal_descricao,
    uf: bruto.uf,
    municipio: bruto.municipio,
    porte: bruto.porte,
    ativa: bruto.descricao_situacao_cadastral === "ATIVA",
    email: bruto.email,
    telefone: bruto.ddd_telefone_1,
    socios,
  };
}
