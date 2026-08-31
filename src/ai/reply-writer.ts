import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";
import {
  EmailDraftSchema,
  type EmailDraft,
  type CampaignVoice,
} from "./email-writer.js";
import type { NextAction } from "../domain/reply-policy.js";

export interface ConversationTurn {
  role: "us" | "lead";
  body: string;
}

/**
 * Só depende da campanha — prefixo cacheado, igual para todas as réplicas.
 */
function buildSystem(voice: CampaignVoice): string {
  return `Você responde, em português brasileiro, a leads que reagiram a um e-mail de prospecção B2B.

O que oferecemos:
${voice.offerDescription}

Tom de voz: ${voice.tone}

Regras invioláveis:
- Máximo de 120 palavras no corpo.
- Nunca cite preço, desconto ou condição comercial: diga que isso depende do escopo e que vale conversar.
- Nunca invente casos, números, clientes ou funcionalidades. Se não souber, reconheça e proponha esclarecer na conversa.
- Nunca prometa prazo de entrega ou resultado.
- Responda ao que o lead perguntou antes de propor o próximo passo.
- O assunto deve manter o fio da conversa, com prefixo "Re:".
- Assine apenas com o primeiro nome: ${voice.senderFirstName}. Sem bloco de assinatura.`;
}

function transcrever(history: ConversationTurn[]): string {
  return history
    .map((turno) => `${turno.role === "us" ? "Nós" : "Lead"}: ${turno.body}`)
    .join("\n\n");
}

function instrucao(action: NextAction, schedulingLink: string): string {
  switch (action.type) {
    case "send_scheduling_link":
      return `O lead demonstrou interesse. Confirme o interesse em uma frase e convide para escolher um horário neste link: ${schedulingLink}`;
    case "answer_and_nudge": {
      const pontos = action.keyPoints.length
        ? action.keyPoints.map((ponto) => `- ${ponto}`).join("\n")
        : "- a dúvida principal levantada na última mensagem";
      return `O lead levantou pontos antes de aceitar conversar. Responda objetivamente a cada um destes pontos:\n${pontos}\n\nDepois de respondê-los, convide para escolher um horário neste link: ${schedulingLink}`;
    }
    case "schedule_followup":
      return `O lead tem interesse, mas não agora. Não insista e não envie link. Agradeça, deixe a porta aberta e diga que você retoma o contato em cerca de ${action.resumeInDays} dias.`;
    case "close_lost":
      return `O lead recusou. Não insista e não envie link: agradeça o retorno em duas frases, deixe a porta aberta para o futuro e encerre.`;
    default:
      throw new Error(
        `A ação "${action.type}" não gera e-mail para o lead.`,
      );
  }
}

export async function writeReply(
  input: {
    voice: CampaignVoice;
    schedulingLink: string;
    history: ConversationTurn[];
    action: NextAction;
  },
  deps: AiDeps = { client: getClient() },
): Promise<EmailDraft> {
  if (input.history.length === 0) {
    throw new Error("Não é possível responder sem histórico da conversa.");
  }
  // Descadastro é encerrado em silêncio: quem pediu para parar não recebe mais e-mail.
  if (input.action.type === "close_lost" && input.action.suppress) {
    throw new Error(
      "Um pedido de descadastro não gera e-mail de resposta.",
    );
  }

  const tarefa = instrucao(input.action, input.schedulingLink);

  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: buildSystem(input.voice),
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      format: zodOutputFormat(EmailDraftSchema),
      effort: "medium",
    },
    messages: [
      {
        role: "user",
        content: `Conversa até aqui:\n\n${transcrever(input.history)}\n\nSua tarefa: ${tarefa}`,
      },
    ],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para a réplica (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
