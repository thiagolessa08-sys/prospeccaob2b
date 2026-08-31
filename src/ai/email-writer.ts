import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";

export const EmailDraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export type EmailDraft = z.infer<typeof EmailDraftSchema>;

export interface CampaignVoice {
  offerDescription: string;
  tone: string;
}

export interface CompanyContext {
  legalName: string;
  tradeName: string | null;
  summary: string | null;
  city: string | null;
  uf: string | null;
}

export interface LeadContext {
  fullName: string | null;
  roleTitle: string | null;
}

const AUSENTE = "não disponível";

/**
 * Só depende da campanha, nunca do lead — é o prefixo cacheado, reaproveitado
 * em todos os e-mails da mesma campanha.
 */
export function buildVoiceSystem(voice: CampaignVoice): string {
  return `Você escreve e-mails de primeiro contato (cold e-mail) B2B em português brasileiro.

O que oferecemos:
${voice.offerDescription}

Tom de voz: ${voice.tone}

Regras invioláveis:
- Máximo de 120 palavras no corpo.
- Assunto com no máximo 60 caracteres, sem emoji, sem promessa exagerada, sem "urgente".
- Nunca cite preço, desconto ou condição comercial.
- Nunca invente fatos sobre a empresa do destinatário: use apenas o que estiver no contexto fornecido.
- Nunca inclua link de agendamento neste primeiro e-mail.
- Faça uma única pergunta clara no final, de baixo compromisso.
- Não use saudações genéricas do tipo "Espero que esteja tudo bem".
- Assine apenas com o primeiro nome do remetente, sem bloco de assinatura.`;
}

function buildLeadPrompt(company: CompanyContext, lead: LeadContext): string {
  const localizacao = [company.city, company.uf].filter(Boolean).join("/");
  return `Escreva o e-mail para este destinatário.

Empresa: ${company.tradeName ?? company.legalName}
Razão social: ${company.legalName}
Localização: ${localizacao || AUSENTE}
O que a empresa faz: ${company.summary ?? AUSENTE}

Destinatário: ${lead.fullName ?? AUSENTE}
Cargo: ${lead.roleTitle ?? AUSENTE}`;
}

export async function writeFirstEmail(
  input: { voice: CampaignVoice; company: CompanyContext; lead: LeadContext },
  deps: AiDeps = { client: getClient() },
): Promise<EmailDraft> {
  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: buildVoiceSystem(input.voice),
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      format: zodOutputFormat(EmailDraftSchema),
      effort: "medium",
    },
    messages: [
      { role: "user", content: buildLeadPrompt(input.company, input.lead) },
    ],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para o e-mail (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
