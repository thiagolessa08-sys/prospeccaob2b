import type { Db } from "../db/port.js";
import { buscarCampanha } from "../db/repositories/campaigns.js";
import {
  buscarLead,
  transicionarLead,
  incrementarTrocas,
  atualizarLead,
} from "../db/repositories/leads.js";
import {
  carregarConversa,
  atualizarClassificacao,
} from "../db/repositories/messages.js";
import { adicionarSupressao } from "../db/repositories/suppression.js";
import { registrarEvento } from "../db/repositories/events.js";
import { ruleForOptOut } from "../domain/suppression.js";
import { canTransition } from "../domain/stages.js";
import { decideNextAction, type NextAction } from "../domain/reply-policy.js";
import { classifyReply } from "../ai/reply-classifier.js";
import { writeReply, type ConversationTurn } from "../ai/reply-writer.js";
import type { ColdEmailProvider, EmailParaEnviar } from "../sending/types.js";

export interface DepsProcessarResposta {
  classificar: typeof classifyReply;
  escreverReply: typeof writeReply;
}

const DEPS_PADRAO: DepsProcessarResposta = {
  classificar: classifyReply,
  escreverReply: writeReply,
};

export type ResultadoDoProcessamento =
  | { processado: true; acao: NextAction["type"] }
  | { processado: false; motivo: string };

/**
 * A rota lenta: classifica a última resposta do lead, decide o que fazer e,
 * quando a ação gera e-mail, escreve e envia a réplica.
 *
 * É aqui — não no webhook — que a IA entra. Classificar e redigir levam
 * dezenas de segundos; o webhook só grava e responde 2xx. Quem dispara esta
 * função é o n8n, de forma assíncrona, depois que o webhook confirmou a
 * chegada da resposta.
 */
export async function processarResposta(
  input: {
    db: Db;
    tenantId: string;
    leadId: string;
    provedor: ColdEmailProvider;
  },
  deps: DepsProcessarResposta = DEPS_PADRAO,
): Promise<ResultadoDoProcessamento> {
  const { db, tenantId, leadId, provedor } = input;

  const lead = await buscarLead(db, tenantId, leadId);
  if (!lead) return { processado: false, motivo: "Lead não encontrado." };

  const campanha = await buscarCampanha(db, tenantId, lead.campaign_id);
  if (!campanha) {
    return { processado: false, motivo: "Campanha do lead não encontrada." };
  }

  const conversa = await carregarConversa(db, tenantId, leadId);

  // A resposta pendente é a última recebida ainda sem classificação. Reler
  // por esse critério — em vez de guardar "qual foi a última processada" em
  // outro lugar — torna a função idempotente por construção: reprocessar um
  // lead já em dia simplesmente não acha nada para fazer.
  const pendente = [...conversa]
    .reverse()
    .find((m) => m.direction === "inbound" && m.intent === null);

  if (!pendente) {
    return {
      processado: false,
      motivo: "Nenhuma resposta pendente de classificação.",
    };
  }

  const classificacao = await deps.classificar(pendente.body);

  await atualizarClassificacao(db, tenantId, pendente.id, {
    intent: classificacao.intent,
    confidence: classificacao.confidence,
    aiReasoning: classificacao.reasoning,
  });

  const acao = decideNextAction({
    classification: classificacao,
    exchangeCount: lead.exchange_count,
    needsHuman: lead.needs_human,
  });

  const historico: ConversationTurn[] = conversa.map((m) => ({
    role: m.direction === "outbound" ? "us" : "lead",
    body: m.body,
  }));

  const voice = {
    offerDescription: campanha.offer_description,
    briefing: campanha.pitch_briefing,
    tone: campanha.tone,
    senderFirstName: campanha.sender_first_name,
  };

  const responder = async (acaoComEmail: NextAction) => {
    const rascunho = await deps.escreverReply({
      voice,
      schedulingLink: campanha.scheduling_link,
      history: historico,
      action: acaoComEmail,
    });
    const [primeiroNome] = (lead.full_name ?? "").trim().split(/\s+/);
    const email: EmailParaEnviar = {
      tenantId,
      leadId,
      email: lead.email,
      primeiroNome: primeiroNome || null,
      sobrenome: null,
      empresa: null,
      site: null,
      assunto: rascunho.subject,
      corpo: rascunho.body,
    };
    const resultado = await provedor.enviar(email);
    if (!resultado.enviado) {
      await registrarEvento(db, {
        tenantId,
        leadId,
        kind: "falha_ao_responder",
        payload: { motivo: resultado.motivo, acao: acaoComEmail.type },
      });
    }
    await incrementarTrocas(db, tenantId, leadId);
  };

  // A classificação já foi gravada acima. Se a etapa abaixo falhar — a IA da
  // réplica caiu, o envio deu erro inesperado — um reprocessamento não acharia
  // mais nada pendente (a mensagem já tem `intent`), e a resposta do lead
  // ficaria perdida em silêncio. Por isso a ação inteira é protegida: uma
  // falha aqui vira repasse a humano em vez de desaparecer.
  try {
    switch (acao.type) {
      case "close_lost": {
        if (acao.suppress) {
          // Descadastro pedido em texto livre, não pelo mecanismo do
          // Instantly: quem pediu para parar não recebe nem uma despedida.
          await adicionarSupressao(
            db,
            tenantId,
            ruleForOptOut(lead.email),
            "descadastro identificado na conversa",
          );
        } else {
          await responder(acao);
        }
        if (canTransition(lead.stage, "discarded")) {
          await transicionarLead(db, tenantId, leadId, "discarded", {
            discardReason: acao.reason,
          });
        }
        break;
      }

      case "handoff_to_human": {
        await atualizarLead(db, tenantId, leadId, {
          needsHuman: true,
          handoffReason: acao.reason,
        });
        break;
      }

      case "ignore": {
        await registrarEvento(db, {
          tenantId,
          leadId,
          kind: "resposta_ignorada",
          payload: { motivo: acao.reason },
        });
        break;
      }

      case "schedule_followup": {
        await responder(acao);
        const resumeAt = new Date(
          Date.now() + acao.resumeInDays * 24 * 60 * 60 * 1000,
        );
        await atualizarLead(db, tenantId, leadId, { resumeAt });
        break;
      }

      case "send_scheduling_link":
      case "answer_and_nudge": {
        await responder(acao);
        break;
      }
    }
  } catch (erro) {
    const mensagemDeErro = erro instanceof Error ? erro.message : String(erro);
    await registrarEvento(db, {
      tenantId,
      leadId,
      kind: "falha_ao_processar_resposta",
      payload: { acao: acao.type, erro: mensagemDeErro },
    });
    await atualizarLead(db, tenantId, leadId, {
      needsHuman: true,
      handoffReason: `Falha ao processar automaticamente (${acao.type}): ${mensagemDeErro}`,
    });
    return { processado: true, acao: "handoff_to_human" };
  }

  return { processado: true, acao: acao.type };
}
