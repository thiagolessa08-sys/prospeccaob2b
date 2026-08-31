import type { Db } from "../port.js";
import type { Message, ReplyIntent } from "../types.js";

export interface NovaMensagem {
  tenantId: string;
  leadId: string;
  direction: "outbound" | "inbound";
  body: string;
  subject?: string;
  intent?: ReplyIntent;
  confidence?: number;
  aiReasoning?: string;
  externalId?: string;
}

const COLUNAS = `id, tenant_id, lead_id, direction, subject, body, intent,
  confidence, ai_reasoning, external_id, created_at`;

/**
 * Anexa uma mensagem à conversa.
 *
 * Devolve `null` quando o `externalId` já existe. O Instantly repete a entrega
 * do webhook em qualquer resposta não-2xx, e sem isso a reentrega geraria uma
 * segunda classificação e uma segunda réplica **enviada ao lead**. Deixar o
 * índice único decidir, e tratar o conflito como "já processei", é o que torna
 * o webhook idempotente.
 */
export async function anexarMensagem(
  db: Db,
  input: NovaMensagem,
): Promise<Message | null> {
  const { rows } = await db.query<Message>(
    `insert into messages
       (tenant_id, lead_id, direction, subject, body, intent, confidence,
        ai_reasoning, external_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict do nothing
     returning ${COLUNAS}`,
    [
      input.tenantId,
      input.leadId,
      input.direction,
      input.subject ?? null,
      input.body,
      input.intent ?? null,
      input.confidence ?? null,
      input.aiReasoning ?? null,
      input.externalId ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function carregarConversa(
  db: Db,
  tenantId: string,
  leadId: string,
): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `select ${COLUNAS} from messages
     where tenant_id = $1 and lead_id = $2
     order by created_at, id`,
    [tenantId, leadId],
  );
  return rows;
}
