import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import {
  buscarLeadPorEmail,
  marcarBounce,
  transicionarLead,
} from "../../db/repositories/leads.js";
import { anexarMensagem } from "../../db/repositories/messages.js";
import { adicionarSupressao } from "../../db/repositories/suppression.js";
import { registrarEvento } from "../../db/repositories/events.js";
import { ruleForOptOut } from "../../domain/suppression.js";
import { canTransition } from "../../domain/stages.js";
import type { Lead } from "../../db/types.js";

/** Header que carrega o segredo. O Instantly o envia porque nós o registramos. */
export const HEADER_SEGREDO = "x-prospeccao-segredo";

export interface DepsInstantly {
  db: Db;
  /** Injetado, não lido aqui: quando virar produto, vem da URL por tenant. */
  tenantId: string;
  segredo: string;
}

interface CorpoDoWebhook {
  event_type?: unknown;
  lead_email?: unknown;
  email_id?: unknown;
  reply_subject?: unknown;
  reply_text?: unknown;
  reply_html?: unknown;
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/**
 * Recebe os sinais do Instantly.
 *
 * Verifica, grava e responde 2xx. **Não chama a IA**: classificar e responder
 * são dezenas de segundos, e um webhook lento faz o Instantly considerar a
 * entrega falha e reentregar. O processamento é do plano seguinte, disparado
 * pelo n8n.
 *
 * Nunca devolve 5xx para entrada malformada — um 5xx faria o Instantly
 * reentregar para sempre.
 */
export async function tratarWebhookInstantly(
  req: Request,
  deps: DepsInstantly,
): Promise<Response> {
  // O segredo é conferido antes de qualquer leitura do banco.
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  let corpo: CorpoDoWebhook;
  try {
    corpo = JSON.parse(await req.text()) as CorpoDoWebhook;
  } catch {
    return new Response("corpo não é JSON válido", { status: 400 });
  }

  const evento = typeof corpo.event_type === "string" ? corpo.event_type : null;
  if (!evento) {
    return new Response("event_type ausente", { status: 400 });
  }

  const email = typeof corpo.lead_email === "string" ? corpo.lead_email : "";
  const externalId = typeof corpo.email_id === "string" ? corpo.email_id : undefined;

  const lead = email
    ? await buscarLeadPorEmail(deps.db, deps.tenantId, email)
    : null;

  switch (evento) {
    case "reply_received":
      await tratarResposta(deps, lead, email, corpo, externalId);
      return ok();

    case "email_bounced":
      if (lead) {
        await marcarBounce(deps.db, deps.tenantId, lead.id);
        await descartar(deps, lead, "endereço deu bounce");
      } else {
        await semLead(deps, evento, email);
      }
      return ok();

    case "lead_unsubscribed":
      // A supressão é gravada mesmo sem lead casado: alguém pediu para sair, e
      // não achar o registro dele aqui não torna o pedido menos válido.
      if (email) {
        await adicionarSupressao(
          deps.db,
          deps.tenantId,
          ruleForOptOut(email),
          "descadastro pelo Instantly",
        );
      }
      if (lead) await descartar(deps, lead, "pedido de descadastro");
      return ok();

    default:
      // Inclui auto_reply_received e qualquer evento novo que o Instantly
      // venha a mandar. Responder 2xx impede reentrega de algo que não nos
      // interessa.
      await registrarEvento(deps.db, {
        tenantId: deps.tenantId,
        leadId: lead?.id ?? null,
        kind: "webhook_ignorado",
        payload: { evento, email },
      });
      return ok();
  }
}

async function tratarResposta(
  deps: DepsInstantly,
  lead: Lead | null,
  email: string,
  corpo: CorpoDoWebhook,
  externalId: string | undefined,
): Promise<void> {
  if (!lead) {
    await semLead(deps, "reply_received", email);
    return;
  }

  const texto =
    typeof corpo.reply_text === "string" && corpo.reply_text.length > 0
      ? corpo.reply_text
      : typeof corpo.reply_html === "string"
        ? corpo.reply_html
        : "";

  const gravada = await anexarMensagem(deps.db, {
    tenantId: deps.tenantId,
    leadId: lead.id,
    direction: "inbound",
    subject: typeof corpo.reply_subject === "string" ? corpo.reply_subject : undefined,
    body: texto,
    externalId,
  });

  // `null` significa que este `email_id` já foi processado — reentrega do
  // Instantly. Nada a fazer, e responder 2xx encerra o ciclo.
  if (!gravada) return;

  // Só transiciona quando o funil permite. Um lead que já está em conversa
  // recebendo outra resposta é o caso comum, e não é erro.
  if (canTransition(lead.stage, "in_conversation")) {
    await transicionarLead(deps.db, deps.tenantId, lead.id, "in_conversation");
  }
}

async function descartar(
  deps: DepsInstantly,
  lead: Lead,
  motivo: string,
): Promise<void> {
  if (canTransition(lead.stage, "discarded")) {
    await transicionarLead(deps.db, deps.tenantId, lead.id, "discarded", {
      discardReason: motivo,
    });
  }
}

async function semLead(
  deps: DepsInstantly,
  evento: string,
  email: string,
): Promise<void> {
  await registrarEvento(deps.db, {
    tenantId: deps.tenantId,
    leadId: null,
    kind: "webhook_sem_lead",
    payload: { evento, email },
  });
}
