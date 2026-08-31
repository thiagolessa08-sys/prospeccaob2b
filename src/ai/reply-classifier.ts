import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";
import { REPLY_INTENTS } from "../db/types.js";

export const ReplyClassificationSchema = z.object({
  intent: z.enum(REPLY_INTENTS),
  confidence: z.number(),
  reasoning: z.string(),
  key_points: z.array(z.string()),
});

export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

const SYSTEM = `Você classifica respostas a e-mails de prospecção B2B em português brasileiro.

Escolha exatamente uma intenção:
- interested: demonstra interesse em conversar, pede reunião, pergunta por disponibilidade.
- question_or_objection: quer conversar mas antes tem dúvida, ressalva ou objeção a tratar.
- not_now: há interesse, mas o momento não é agora ("me procure em três meses").
- no: recusa clara, sem interesse, sem pedir para parar de receber contato.
- opt_out: pede explicitamente para ser removido, descadastrado ou para não receber mais e-mails.
- out_of_scope: não é uma resposta humana à proposta — resposta automática de ausência, aviso de entrega, encaminhamento sem conteúdo, pessoa que saiu da empresa.

confidence: sua certeza na classificação, de 0 a 1. Use valor abaixo de 0,7 quando o texto for ambíguo, muito curto ou puder ter mais de uma leitura — um humano vai revisar esses casos.
reasoning: uma frase em português explicando a escolha.
key_points: os pontos concretos levantados pelo lead que a resposta precisa endereçar. Lista vazia se não houver nenhum.

Na dúvida entre "no" e "opt_out", escolha "opt_out": deixar de contatar alguém que queria conversar custa menos do que insistir com quem pediu para parar.`;

function clampConfidence(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.min(1, Math.max(0, valor));
}

export async function classifyReply(
  replyBody: string,
  deps: AiDeps = { client: getClient() },
): Promise<ReplyClassification> {
  if (replyBody.trim().length === 0) {
    throw new Error("Não é possível classificar uma resposta vazia.");
  }

  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      format: zodOutputFormat(ReplyClassificationSchema),
      effort: "low",
    },
    messages: [
      { role: "user", content: `Resposta recebida:\n\n${replyBody}` },
    ],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para a classificação (stop_reason=${resposta.stop_reason}).`,
    );
  }

  return {
    ...resposta.parsed_output,
    confidence: clampConfidence(resposta.parsed_output.confidence),
  };
}
