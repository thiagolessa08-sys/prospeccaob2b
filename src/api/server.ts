import { Hono } from "hono";
import type { Db } from "../db/port.js";
import { tratarWebhookInstantly } from "./handlers/instantly-webhook.js";
import { tratarWebhookCalcom } from "./handlers/calcom-webhook.js";

export interface DepsDoApp {
  db: Db;
  tenantId: string;
  segredoInstantly: string;
  segredoCalcom: string;
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

  return app;
}
