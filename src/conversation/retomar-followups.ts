import type { Db } from "../db/port.js";
import { buscarCampanha } from "../db/repositories/campaigns.js";
import {
  listarProntosParaRetomar,
  limparRetomada,
  atualizarLead,
} from "../db/repositories/leads.js";
import { carregarConversa } from "../db/repositories/messages.js";
import { registrarEvento } from "../db/repositories/events.js";
import { writeFollowupNudge, type ConversationTurn } from "../ai/reply-writer.js";
import type { ColdEmailProvider, EmailParaEnviar } from "../sending/types.js";

export interface DepsRetomarFollowups {
  escreverFollowup: typeof writeFollowupNudge;
}

const DEPS_PADRAO: DepsRetomarFollowups = {
  escreverFollowup: writeFollowupNudge,
};

export interface ResultadoDoRetomarFollowups {
  processados: number;
  enviados: number;
  falhas: number;
  motivo: string;
}

/**
 * Cumpre o prazo que `processarResposta` prometeu num "não agora": busca os
 * leads cujo `resume_at` já venceu e reabre o contato.
 *
 * Rota lenta, chamada pelo n8n na agenda — nunca por um webhook, porque não
 * existe evento externo que dispare isto: o gatilho é o relógio, não uma
 * resposta do lead.
 */
export async function retomarFollowups(
  input: {
    db: Db;
    tenantId: string;
    campaignId: string;
    provedor: ColdEmailProvider;
    limite?: number;
  },
  deps: DepsRetomarFollowups = DEPS_PADRAO,
): Promise<ResultadoDoRetomarFollowups> {
  const { db, tenantId, campaignId, provedor, limite = 20 } = input;
  const vazio = { processados: 0, enviados: 0, falhas: 0 };

  const campanha = await buscarCampanha(db, tenantId, campaignId);
  if (!campanha) {
    return { ...vazio, motivo: "Campanha não encontrada." };
  }

  const prontos = await listarProntosParaRetomar(db, tenantId, campaignId, limite);
  if (prontos.length === 0) {
    return { ...vazio, motivo: "Nenhum lead com retomada vencida." };
  }

  const voice = {
    offerDescription: campanha.offer_description,
    tone: campanha.tone,
    senderFirstName: campanha.sender_first_name,
  };

  let enviados = 0;
  let falhas = 0;

  for (const lead of prontos) {
    try {
      const conversa = await carregarConversa(db, tenantId, lead.id);
      const historico: ConversationTurn[] = conversa.map((m) => ({
        role: m.direction === "outbound" ? "us" : "lead",
        body: m.body,
      }));

      const rascunho = await deps.escreverFollowup({
        voice,
        schedulingLink: campanha.scheduling_link,
        history: historico,
      });

      const [primeiroNome] = (lead.full_name ?? "").trim().split(/\s+/);
      const email: EmailParaEnviar = {
        tenantId,
        leadId: lead.id,
        email: lead.email,
        primeiroNome: primeiroNome || null,
        sobrenome: null,
        empresa: null,
        site: null,
        assunto: rascunho.subject,
        corpo: rascunho.body,
      };
      const resultado = await provedor.enviar(email);

      // Limpa mesmo quando o envio falha: sem isso, um endereço com problema
      // permanente (que `resultado.enviado` recusa toda vez) seria
      // reprocessado nesta mesma varredura, para sempre, na próxima chamada
      // agendada. `falha_ao_retomar_followup` fica registrado para revisão.
      await limparRetomada(db, tenantId, lead.id);

      if (!resultado.enviado) {
        falhas += 1;
        await registrarEvento(db, {
          tenantId,
          leadId: lead.id,
          kind: "falha_ao_retomar_followup",
          payload: { motivo: resultado.motivo },
        });
        continue;
      }

      enviados += 1;
    } catch (erro) {
      falhas += 1;
      const mensagemDeErro = erro instanceof Error ? erro.message : String(erro);
      // Mesma rede de segurança de `processarResposta`: uma falha no meio do
      // caminho (IA fora do ar, erro inesperado do provedor) não pode deixar
      // o lead preso num prazo vencido para sempre nem sumir em silêncio.
      await limparRetomada(db, tenantId, lead.id).catch(() => {});
      await atualizarLead(db, tenantId, lead.id, {
        needsHuman: true,
        handoffReason: `Falha ao retomar follow-up automaticamente: ${mensagemDeErro}`,
      }).catch(() => {});
      await registrarEvento(db, {
        tenantId,
        leadId: lead.id,
        kind: "falha_ao_retomar_followup",
        payload: { erro: mensagemDeErro },
      }).catch(() => {});
    }
  }

  return {
    processados: prontos.length,
    enviados,
    falhas,
    motivo: `Processados ${prontos.length}, ${enviados} follow-up(s) enviado(s), ${falhas} falha(s).`,
  };
}
