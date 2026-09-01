import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";

/**
 * O briefing que guia o escritor de e-mail.
 *
 * É briefing, e não modelo pronto: o funil escreve um e-mail por lead, com o
 * nome da empresa e o cargo do decisor na mão. Congelar o texto aqui jogaria
 * fora essa personalização — o que sobe a chance de o e-mail parecer disparo
 * em massa, que é justamente o que faz cair em spam e não ser respondido.
 */
export const BriefingSchema = z.object({
  /** A ideia central da abordagem, em uma frase. */
  angulo: z.string(),
  /** As dores que o destinatário reconhece como suas. */
  dores: z.array(z.string()),
  /** Números, casos ou fatos que sustentam a promessa. */
  provas: z.array(z.string()),
  /** O que não dizer: jargão, promessa exagerada, assunto sensível. */
  evitar: z.array(z.string()),
});

export type Briefing = z.infer<typeof BriefingSchema>;

export const PropostaSchema = z.object({
  /** Vira `campaigns.niche_description`, que alimenta `parseNiche`. */
  nicho: z.string(),
  /** Vira `campaigns.offer_description`, que alimenta a voz da campanha. */
  oferta: z.string(),
  /** Cargos do decisor. Viram `filters.target_roles` na aprovação. */
  cargos: z.array(z.string()),
  briefing: BriefingSchema,
  /**
   * Um e-mail de amostra. Não é usado no disparo — existe para a pessoa ver
   * o tom antes de aprovar, porque julgar um briefing no abstrato é difícil
   * e julgar um e-mail escrito é imediato.
   */
  exemplo_de_email: z.object({
    assunto: z.string(),
    corpo: z.string(),
  }),
});

export type Proposta = z.infer<typeof PropostaSchema>;

/**
 * Prompt fixo: é o prefixo cacheado. Qualquer alteração aqui invalida o cache
 * de todas as campanhas, então mantenha estável.
 */
const SYSTEM = `Você desenha campanhas de prospecção B2B no Brasil. Recebe, em texto livre, o propósito de uma solução que será vendida, e devolve a campanha inteira proposta.

Regras:
- nicho: descreva as empresas que mais sofrem o problema que a solução resolve — atividade, porte e região quando fizerem diferença. Escreva como quem descreve um alvo de prospecção, não como quem escreve marketing. Este texto será convertido em CNAE, UF e porte depois, então seja concreto sobre a atividade.
- oferta: o que entregamos, em uma ou duas frases, do ponto de vista do resultado para o cliente — não da tecnologia.
- cargos: quem decide a compra, em português e na forma como aparece em títulos reais ("Diretor Industrial", "Gerente de TI"). Prefira dois ou três cargos a uma lista longa.
- briefing.angulo: a ideia central da abordagem em uma frase.
- briefing.dores: dores que o destinatário reconheceria como dele. Concretas, do dia a dia dele, nunca genéricas como "aumentar eficiência".
- briefing.provas: o que sustenta a promessa. Se o propósito informado não trouxer número nem caso, proponha o TIPO de prova que deveria ser usada e diga que falta — nunca invente número, cliente ou resultado.
- briefing.evitar: o que não dizer nesta campanha.
- exemplo_de_email: um e-mail de primeiro contato completo, curto, em português brasileiro, como amostra do tom. Use o marcador [EMPRESA] onde entraria o nome da empresa e [NOME] onde entraria o nome da pessoa.

Nunca invente dado sobre o cliente de quem está vendendo. Se o propósito for vago demais para uma decisão, escolha a leitura mais provável e deixe explícito em briefing.evitar o que ficou por confirmar.`;

/**
 * Transforma o propósito da solução na campanha proposta.
 *
 * Uma chamada só para tudo — nicho, cargos e discurso — de propósito: as três
 * coisas precisam ser coerentes entre si, e pedi-las em chamadas separadas
 * produziria um discurso que fala com um público diferente do que os filtros
 * vão buscar.
 */
export async function proporCampanha(
  propositoDaSolucao: string,
  deps: AiDeps = { client: getClient() },
): Promise<Proposta> {
  if (propositoDaSolucao.trim().length === 0) {
    throw new Error("O propósito da solução não pode estar vazio.");
  }

  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 8192,
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      format: zodOutputFormat(PropostaSchema),
      effort: "high",
    },
    messages: [{ role: "user", content: propositoDaSolucao }],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para a proposta (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
