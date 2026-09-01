import { serve } from "@hono/node-server";
import { criarApp } from "./server.js";
import { getDb } from "../db/postgres.js";
import { env } from "../config/env.js";

const ambiente = env();

const app = criarApp({
  db: getDb(ambiente.DATABASE_URL),
  tenantId: ambiente.TENANT_ID,
  segredoInstantly: ambiente.INSTANTLY_WEBHOOK_SECRET,
  segredoCalcom: ambiente.CALCOM_WEBHOOK_SECRET,
  segredoN8n: ambiente.N8N_SHARED_SECRET,
  senhaDoPainel: ambiente.PAINEL_SENHA,
  apiKeyHunter: ambiente.HUNTER_API_KEY,
  apiKeyLusha: ambiente.LUSHA_API_KEY,
  loteDeEnriquecimento: ambiente.LOTE_DE_ENRIQUECIMENTO,
  apiKeyCasaDosDados: ambiente.CASA_DOS_DADOS_API_KEY,
});

const porta = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port: porta });
console.log(`Servidor ouvindo na porta ${porta}`);
