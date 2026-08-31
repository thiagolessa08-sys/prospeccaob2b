import type { Db } from "../port.js";
import type { Message, ReplyIntent } from "../types.js";

export interface NovaMensagem {
  tenantId: string;
  leadId: string;
  direction: "outbound" | "inbound";
  body: string;
  subject?: string;
  intent?: ReplyIntent;
  /**
   * Entra como número — escrever um `numeric` a partir de um `number` é
   * seguro. Volta como string em `Message.confidence`, porque nenhum dos dois
   * drivers converte `numeric`.
   */
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
 *
 * O lead é conferido numa consulta à parte, e não com um `where exists` no
 * próprio insert, justamente para não confundir os dois casos de "nenhuma
 * linha voltou": lead de outro tenant precisa **lançar**, reentrega do mesmo
 * webhook precisa devolver `null`. Se o `exists` falhasse em silêncio, o
 * chamador responderia 2xx ao Instantly e a resposta do lead sumiria.
 */
export async function anexarMensagem(
  db: Db,
  input: NovaMensagem,
): Promise<Message | null> {
  const { rows: doTenant } = await db.query(
    `select 1 from leads where tenant_id = $1 and id = $2`,
    [input.tenantId, input.leadId],
  );
  if (!doTenant[0]) {
    throw new Error(
      `Lead ${input.leadId} não pertence ao tenant ${input.tenantId}: ` +
        `uma mensagem não pode cruzar tenants.`,
    );
  }

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
