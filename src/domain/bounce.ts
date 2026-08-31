/** Acima disto a campanha se pausa sozinha. Vem do spec §5. */
export const LIMITE_DE_BOUNCE = 0.03;

/**
 * Envios mínimos antes de a taxa significar alguma coisa.
 *
 * Sem este piso, 1 bounce nos 3 primeiros envios daria 33% e pausaria toda
 * campanha nova no terceiro e-mail — o disjuntor viraria um obstáculo em vez de
 * uma proteção.
 */
export const AMOSTRA_MINIMA = 20;

export type EstadoDoDisjuntor =
  | { abrir: true; taxa: number; motivo: string }
  | { abrir: false; taxa: number | null; motivo: string };

/**
 * Decide se a campanha deve ser pausada pela taxa de bounce.
 *
 * Puro de propósito: a contagem vem do banco, a decisão mora aqui, e a pausa é
 * de quem chama. Assim cada parte é testável sozinha.
 */
export function avaliarDisjuntor(input: {
  enviados: number;
  bounces: number;
}): EstadoDoDisjuntor {
  const { enviados, bounces } = input;

  if (!Number.isFinite(enviados) || !Number.isFinite(bounces)) {
    return {
      abrir: false,
      taxa: null,
      motivo: "Contagem inválida: não dá para avaliar a taxa de bounce.",
    };
  }

  if (enviados < AMOSTRA_MINIMA) {
    return {
      abrir: false,
      taxa: null,
      motivo: `Amostra insuficiente: ${enviados} envio(s), mínimo de ${AMOSTRA_MINIMA}.`,
    };
  }

  const bouncesValidos = Math.max(0, bounces);
  const taxa = Math.min(1, bouncesValidos / enviados);

  if (taxa > LIMITE_DE_BOUNCE) {
    // Duas casas, não uma: com `toFixed(1)` uma taxa de 3,001% virava
    // "3.0%, acima do limite de 3%" — a mensagem se contradizendo justo no
    // momento em que alguém precisa entender por que a campanha parou.
    const percentual = (taxa * 100).toFixed(2);
    const limite = (LIMITE_DE_BOUNCE * 100).toFixed(0);
    return {
      abrir: true,
      taxa,
      motivo: `Taxa de bounce em ${percentual}%, acima do limite de ${limite}%.`,
    };
  }

  return {
    abrir: false,
    taxa,
    motivo: `Taxa de bounce em ${(taxa * 100).toFixed(1)}%, dentro do limite.`,
  };
}
