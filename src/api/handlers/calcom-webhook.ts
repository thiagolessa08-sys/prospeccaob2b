import { assinaturaHmacConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import {
  buscarLeadPorEmail,
  transicionarLead,
} from "../../db/repositories/leads.js";
import { registrarEvento } from "../../db/repositories/events.js";
import { canTransition } from "../../domain/stages.js";

/** Header que o Cal.com usa para a assinatura HMAC-SHA256 do corpo cru. */
export const HEADER_ASSINATURA = "x-cal-signature-256";

export interface DepsCalcom {
  db: Db;
  /** Injetado, não lido aqui: quando virar produto, vem da URL por tenant. */
  tenantId: string;
  segredo: string;
}

interface CorpoDoCalcom {
  triggerEvent?: unknown;
  payload?: {
    uid?: unknown;
    type?: unknown;
    startTime?: unknown;
    attendees?: Array<{ email?: unknown; name?: unknown }>;
  };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/**
 * Recebe os agendamentos do Cal.com.
 *
 * O lead é encontrado pelo e-mail do participante — o link é enviado com o
 * endereço já preenchido. O prospect pode editá-lo antes de confirmar, e nesse
 * caso nenhum lead casa: registramos o agendamento inteiro em `events` e ainda
 * devolvemos 2xx. Uma reunião marcada que o sistema não registra é pior do que
 * um erro visível, e o Cal.com não tem culpa.
 */
export async function tratarWebhookCalcom(
  req: Request,
  deps: DepsCalcom,
): Promise<Response> {
  // O corpo só pode ser lido uma vez, e a assinatura é sobre o texto cru:
  // reserializar mudaria espaçamento e ordem de chaves.
  const bruto = await req.text();

  if (
    !assinaturaHmacConfere(bruto, req.headers.get(HEADER_ASSINATURA), deps.segredo)
  ) {
    return new Response("assinatura inválida", { status: 401 });
  }

  let corpo: CorpoDoCalcom;
  try {
    corpo = JSON.parse(bruto) as CorpoDoCalcom;
  } catch {
    return new Response("corpo não é JSON válido", { status: 400 });
  }

  const evento =
    typeof corpo.triggerEvent === "string" ? corpo.triggerEvent : null;
  if (!evento) {
    return new Response("triggerEvent ausente", { status: 400 });
  }

  if (evento !== "BOOKING_CREATED") {
    await registrarEvento(deps.db, {
      tenantId: deps.tenantId,
      leadId: null,
      kind: "webhook_calcom_ignorado",
      payload: { evento },
    });
    return ok();
  }

  const payload = corpo.payload ?? {};
  const participante = payload.attendees?.[0];
  const email = typeof participante?.email === "string" ? participante.email : "";
  const uid = typeof payload.uid === "string" ? payload.uid : null;
  const inicio = typeof payload.startTime === "string" ? payload.startTime : null;
  const tipo = typeof payload.type === "string" ? payload.type : null;

  const lead = email
    ? await buscarLeadPorEmail(deps.db, deps.tenantId, email)
    : null;

  if (!lead) {
    await registrarEvento(deps.db, {
      tenantId: deps.tenantId,
      leadId: null,
      kind: "agendamento_sem_lead",
      payload: { email, uid, inicio, tipo },
    });
    return ok();
  }

  // Só transiciona quando o funil permite. Uma reentrega chega com o lead já em
  // `meeting_booked`, e isso não é erro.
  if (canTransition(lead.stage, "meeting_booked")) {
    await transicionarLead(deps.db, deps.tenantId, lead.id, "meeting_booked");
  }

  await registrarEvento(deps.db, {
    tenantId: deps.tenantId,
    leadId: lead.id,
    kind: "reuniao_marcada",
    payload: { email, uid, inicio, tipo },
  });

  return ok();
}
