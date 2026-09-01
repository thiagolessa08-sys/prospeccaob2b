import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";

export const NicheFiltersSchema = z.object({
  cnaes: z.array(z.string()),
  ufs: z.array(z.string()),
  cities: z.array(z.string()),
  min_employees: z.number().nullable(),
  max_employees: z.number().nullable(),
  target_roles: z.array(z.string()),
  keywords: z.array(z.string()),
  /**
   * Os três campos abaixo são o vocabulário da Lusha, não o da Receita.
   *
   * Opcionais com padrão vazio de propósito: as campanhas cujos filtros foram
   * gerados antes destes campos existirem continuam válidas, e `safeParse`
   * segue passando nelas. Sem isso, ligar a descoberta pela Lusha faria toda
   * campanha antiga responder "sem filtros salvos".
   */
  setores: z.array(z.string()).optional().default([]),
  tecnologias: z.array(z.string()).optional().default([]),
  paises: z.array(z.string()).optional().default([]),
});

export type NicheFilters = z.infer<typeof NicheFiltersSchema>;

/**
 * Prompt fixo: é o prefixo cacheado. Qualquer alteração aqui invalida o cache
 * de todas as campanhas, então mantenha estável.
 */
const SYSTEM = `Você converte descrições de nicho de prospecção B2B no Brasil em filtros de busca estruturados.

Regras:
- cnaes: códigos CNAE de 7 dígitos, apenas números, somente quando a atividade descrita corresponde claramente ao código. Nunca invente um CNAE.
- ufs: siglas de duas letras maiúsculas. Lista vazia significa Brasil inteiro.
- cities: nomes de cidades exatamente como escritos na descrição.
- min_employees e max_employees: null quando a descrição não menciona porte.
- target_roles: cargos do decisor em português, na forma como aparecem em títulos reais (por exemplo "Gerente de TI", "Diretor de Operações").
- keywords: termos para busca textual complementar, incluindo qualquer atividade que você não conseguiu mapear para um CNAE.

Os três campos seguintes são para a Lusha, que é uma base global e não conhece CNAE nem UF:
- setores: rótulos de setor EM INGLÊS, como aparecem em bases B2B internacionais ("Food & Beverage", "Chemicals", "Metals & Mining", "Automotive", "Wholesale", "Retail"). Dois a cinco, do mais central para o mais periférico.
- tecnologias: nomes de produtos que a empresa-alvo usaria, quando a descrição mencionar algum ("SAP", "TOTVS", "Oracle", "Microsoft Dynamics", "Salesforce"). Só o nome do produto, sem versão. Lista vazia quando a descrição não citar nenhuma.
- paises: nomes de país em inglês ("Brazil"). Quase sempre apenas Brazil.

Na dúvida sobre um CNAE, deixe-o de fora e coloque o termo em keywords.`;

export async function parseNiche(
  description: string,
  deps: AiDeps = { client: getClient() },
): Promise<NicheFilters> {
  if (description.trim().length === 0) {
    throw new Error("A descrição do nicho não pode estar vazia.");
  }

  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      format: zodOutputFormat(NicheFiltersSchema),
      effort: "medium",
    },
    messages: [{ role: "user", content: description }],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para o nicho (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
