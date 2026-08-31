/** Vocabulário próprio do enriquecimento. Nenhum termo de fornecedor vaza daqui. */

export type StatusVerificacao = "valid" | "accept_all" | "invalid" | "unknown";

export type FonteDoDecisor =
  | "cnpj_qsa"
  | "cnpj_email"
  | "hunter_finder"
  | "hunter_domain";

export interface CandidatoDecisor {
  nome: string | null;
  cargo: string | null;
  email: string | null;
  /** 0 a 100. Fontes sem score próprio recebem um valor sintético documentado. */
  confianca: number;
  verificacao: StatusVerificacao;
  fonte: FonteDoDecisor;
}

export interface SocioOuAdmin {
  nome: string;
  qualificacao: string;
}

export interface DadosDaEmpresa {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  cnaePrincipal: string;
  descricaoCnae: string;
  uf: string | null;
  municipio: string | null;
  porte: string | null;
  ativa: boolean;
  email: string | null;
  telefone: string | null;
  socios: readonly SocioOuAdmin[];
}
