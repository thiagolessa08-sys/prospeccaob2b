import type { Mock } from "vitest";
import type { AiDeps } from "../../src/ai/client.js";

/**
 * Monta um `AiDeps` cujo `messages.parse` é um mock do vitest.
 *
 * O cast inseguro mora aqui de propósito. `AiDeps.client` é
 * `Pick<Anthropic, "messages">` para que o código de produção infira o tipo
 * de `parsed_output`, e nenhum mock consegue satisfazer aquela superfície
 * inteira. Concentrando a construção num único lugar, o cast existe uma vez
 * só em vez de se repetir em cada módulo de IA.
 */
export function depsComParse(parse: Mock): AiDeps {
  return { client: { messages: { parse } } } as unknown as AiDeps;
}
