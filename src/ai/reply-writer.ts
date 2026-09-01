import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";
import {
  EmailDraftSchema,
  briefingEmTexto,
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
 *
 * Exportada porque `writeFollowupNudge`, abaixo, escreve para o mesmo lead
 * sob as mesmas regras invioláveis (limite de palavras, sem preço, aviso de
 * descadastro, assinatura só com o primeiro nome) — duplicar o texto aqui
 * arriscaria as duas cópias divergirem com o tempo.
 */
export function buildSystem(voice: CampaignVoice): string {
  return `Você responde, em português brasileiro, a leads que reagiram a um e-mail de prospecção B2B.

O que oferecemos:
${voice.offerDescription}

Tom de voz: ${voice.tone}
${briefingEmTexto(voice.briefing)}

Regras invioláveis:
- Máximo de 120 palavras no corpo.
- Nunca cite preço, desconto ou condição comercial: diga que isso depende do escopo e que vale conversar.
- Nunca invente casos, números, clientes ou funcionalidades. Se não souber, reconheça e proponha esclarecer na conversa.
- Nunca prometa prazo de entrega ou resultado.
- Responda ao que o lead perguntou antes de propor o próximo passo.
- O assunto deve manter o fio da conversa, com prefixo "Re:".
- Antes da assinatura, feche com uma única frase simples avisando que basta responder pedindo para não receber mais contato que o endereço será removido. Sem HTML e sem link de descadastro.
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
    case "handoff_to_human":
    case "ignore":
      throw new Error(
        `A ação "${action.type}" não gera e-mail para o lead.`,
      );
    // Sem este ramo, uma sétima variante de NextAction compilaria em silêncio e
    // só falharia em produção, dentro do webhook, com um lead real esperando.
    default: {
      const _exaustivo: never = action;
      throw new Error(`Ação não suportada: ${JSON.stringify(_exaustivo)}`);
    }
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

/**
 * Escreve o e-mail de retomada, quando o prazo de um "não agora" vence.
 *
 * Diferente de `writeReply`, não nasce de uma resposta nova do lead — é a
 * automação que volta a falar por conta própria, no prazo que ela mesma
 * prometeu. Por isso vive fora de `NextAction`/`decideNextAction`: aquela
 * união modela reações a uma resposta classificada, e esta escrita não reage
 * a nada, só cumpre um compromisso já registrado em `leads.resume_at`.
 */
export async function writeFollowupNudge(
  input: {
    voice: CampaignVoice;
    schedulingLink: string;
    history: ConversationTurn[];
  },
  deps: AiDeps = { client: getClient() },
): Promise<EmailDraft> {
  if (input.history.length === 0) {
    throw new Error("Não é possível retomar contato sem histórico da conversa.");
  }

  const tarefa = `Chegou o prazo que você combinou com o lead para retomar contato depois de ele dizer que não era o momento. Retome com uma frase curta lembrando o combinado, sem soar como cobrança nem repetir a oferta inteira, e convide para marcar um horário neste link: ${input.schedulingLink}`;

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
      `O modelo não devolveu saída estruturada para o follow-up (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
