import type { AlvoDaCampanha } from "./chain.js";

/**
 * Palavras-chave em português para os departamentos que a Hunter aceita no
 * domain-search. Não é uma taxonomia fechada e documentada pela Hunter — os
 * termos usados aqui (`it`, `finance`, `sales`, `marketing`, `hr`,
 * `executive`, `legal`, `support`, `operations`) aparecem nos exemplos
 * oficiais, mas nunca foram confirmados contra uma conta real. Ajustar
 * quando houver dado de acerto de verdade.
 */
const PALAVRAS_POR_DEPARTAMENTO: Record<string, readonly string[]> = {
  it: ["ti", "tecnologia", "sistemas", "infraestrutura", "dados", "desenvolvimento"],
  finance: ["financeiro", "finanças", "financas", "controladoria", "contábil", "contabil"],
  sales: ["vendas", "comercial"],
  marketing: ["marketing"],
  hr: ["rh", "recursos humanos", "pessoas"],
  executive: ["diretor", "diretora", "presidente", "ceo", "cfo", "coo"],
  legal: ["jurídico", "juridico"],
  operations: ["operações", "operacoes", "produção", "producao", "logística", "logistica"],
  support: ["suporte", "atendimento"],
};

const TERMOS_DE_SOCIO = [
  "sócio",
  "socio",
  "proprietário",
  "proprietario",
  "dono",
  "fundador",
  "fundadora",
];

/**
 * Decide qual caminho da cadeia de enriquecimento usar, a partir dos cargos
 * que o nicho da campanha declarou.
 *
 * Quando nenhum cargo bate com um departamento conhecido, o padrão é
 * `socio_ou_dono` — não porque toda campanha mira o dono, mas porque numa PME
 * brasileira o administrador com frequência É o decisor, e é o caminho que a
 * cadeia já percorre de graça pelo quadro societário do CNPJ. Preferível a
 * adivinhar um departamento sem nenhum sinal no texto.
 */
/**
 * Normaliza para comparação por palavra inteira: minúsculas, pontuação
 * trocada por espaço, e espaços nas pontas — assim " coo " não bate dentro
 * de "coordenador" (bug real encontrado nos testes: a sigla de `executive`
 * casava como substring de qualquer cargo com "coo" no meio da palavra).
 */
function normalizarTexto(texto: string): string {
  return ` ${texto.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

export function alvoDaCampanha(targetRoles: readonly string[]): AlvoDaCampanha {
  const normalizados = targetRoles.map((cargo) => normalizarTexto(cargo));

  if (
    normalizados.some((cargo) =>
      TERMOS_DE_SOCIO.some((termo) => cargo.includes(normalizarTexto(termo))),
    )
  ) {
    return { tipo: "socio_ou_dono" };
  }

  for (const [departamento, palavras] of Object.entries(PALAVRAS_POR_DEPARTAMENTO)) {
    if (normalizados.some((cargo) => palavras.some((p) => cargo.includes(normalizarTexto(p))))) {
      return { tipo: "cargo_funcional", departamento, cargos: targetRoles };
    }
  }

  return { tipo: "socio_ou_dono" };
}
