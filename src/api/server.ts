import { Hono } from "hono";
import type { Db } from "../db/port.js";
import { tratarWebhookInstantly } from "./handlers/instantly-webhook.js";
import { tratarWebhookCalcom } from "./handlers/calcom-webhook.js";
import { tratarProcessarResposta } from "./handlers/processar-resposta.js";
import { tratarEnviarLote } from "./handlers/enviar-lote.js";
import { tratarEnriquecerLote } from "./handlers/enriquecer-lote.js";

export interface DepsDoApp {
  db: Db;
  tenantId: string;
  segredoInstantly: string;
  segredoCalcom: string;
  segredoN8n: string;
  apiKeyHunter: string;
}

/**
 * Monta as rotas.
 *
 * O Hono só amarra: toda a lógica está nos handlers, que são funções
 * `Request → Response` comuns. É isso que os torna testáveis por invocação
 * direta — e que permitirá ao painel reexportá-los como route handlers do
 * Next.js sem nenhum adaptador.
 */
export function criarApp(deps: DepsDoApp): Hono {
  const app = new Hono();

  app.get("/saude", (c) => c.json({ ok: true }));

  app.post("/webhooks/instantly", (c) =>
    tratarWebhookInstantly(c.req.raw, {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoInstantly,
    }),
  );

  app.post("/webhooks/calcom", (c) =>
    tratarWebhookCalcom(c.req.raw, {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoCalcom,
    }),
  );

  // Rota lenta: o n8n dispara depois que o webhook já confirmou a chegada da
  // resposta. Nunca é chamada pelo webhook em si.
  app.post("/leads/:id/processar-resposta", (c) =>
    tratarProcessarResposta(c.req.raw, c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // Rota lenta: dispara o disparo diário de uma campanha. O n8n agenda a
  // chamada; ela nunca acontece sozinha.
  app.post("/campaigns/:id/enviar-lote", (c) =>
    tratarEnviarLote(c.req.raw, c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // Rota lenta: acha o decisor de cada empresa pendente. O n8n agenda.
  app.post("/campaigns/:id/enriquecer-lote", (c) =>
    tratarEnriquecerLote(c.req.raw, c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
      apiKeyHunter: deps.apiKeyHunter,
    }),
  );

  return app;
}
