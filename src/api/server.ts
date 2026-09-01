import { Hono } from "hono";
import type { Db } from "../db/port.js";
import { semSegredos } from "../config/redigir.js";
import { tratarWebhookInstantly } from "./handlers/instantly-webhook.js";
import { tratarWebhookCalcom } from "./handlers/calcom-webhook.js";
import { tratarProcessarResposta } from "./handlers/processar-resposta.js";
import { tratarEnviarLote } from "./handlers/enviar-lote.js";
import { tratarEnriquecerLote } from "./handlers/enriquecer-lote.js";
import { tratarDescobrirEmpresas } from "./handlers/descobrir-empresas.js";
import { tratarRetomarFollowups } from "./handlers/retomar-followups.js";
import { tratarListarCampanhasAtivas } from "./handlers/listar-campanhas-ativas.js";
import { tratarCriarCampanha } from "./handlers/criar-campanha.js";
import { tratarGerarFiltros } from "./handlers/gerar-filtros.js";

export interface DepsDoApp {
  db: Db;
  tenantId: string;
  segredoInstantly: string;
  segredoCalcom: string;
  segredoN8n: string;
  apiKeyHunter: string;
  apiKeyCasaDosDados: string;
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

  /**
   * Sem isto, qualquer exceção não tratada vira um "Internal Server Error"
   * mudo: o cliente não sabe o que houve e o log do servidor também não —
   * o Hono não imprime nada por padrão. Aconteceu em produção, e a única
   * saída foi adivinhar a causa de fora.
   *
   * O corpo da resposta segue genérico de propósito (a mensagem de erro pode
   * carregar nome de tabela, SQL, caminho de arquivo), mas o log do servidor
   * recebe o motivo real — passado por `semSegredos`, porque erro de driver
   * costuma embutir a credencial que causou a falha.
   */
  app.onError((erro, c) => {
    const detalhe = erro instanceof Error ? (erro.stack ?? erro.message) : String(erro);
    console.error(
      `[500] ${c.req.method} ${c.req.path}\n${semSegredos(detalhe)}`,
    );
    return c.json({ erro: "erro interno" }, 500);
  });

  // A raiz existe só para não parecer deploy quebrado: um 404 nu em `/` é
  // indistinguível de "serviço não subiu" para quem abre a URL no navegador.
  // Não expõe dado nenhum nem a superfície da API — para isso existe o README.
  app.get("/", (c) =>
    c.json({ servico: "prospeccao-b2b", ok: true, saude: "/saude" }),
  );

  app.get("/saude", (c) => c.json({ ok: true }));

  // Rota lenta (mas barata): o n8n consulta antes das quatro rotas de lote,
  // para saber para quais campanhas disparar cada uma.
  app.get("/campaigns/ativas", (c) =>
    tratarListarCampanhasAtivas(c.req.raw, {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // O ponto de entrada do produto: cria a campanha a partir da descrição em
  // texto livre do nicho. Rota barata — só grava a linha.
  app.post("/campaigns", (c) =>
    tratarCriarCampanha(c.req.raw, {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // Rota lenta: transforma o nicho em texto livre em filtros estruturados
  // via IA. Chamada uma vez depois de criar a campanha; pode ser repetida
  // sozinha se a IA falhar.
  app.post("/campaigns/:id/gerar-filtros", (c) =>
    tratarGerarFiltros(c.req.raw, c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

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

  // Rota lenta: busca empresas novas na Casa dos Dados a partir do filtro de
  // nicho da campanha. O n8n agenda, antes do lote de enriquecimento.
  app.post("/campaigns/:id/descobrir-empresas", (c) =>
    tratarDescobrirEmpresas(c.req.raw, c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
      apiKeyCasaDosDados: deps.apiKeyCasaDosDados,
    }),
  );

  // Rota lenta: reabre contato com os leads cujo "não agora" já venceu o
  // prazo. O n8n agenda — o gatilho é o relógio, não um webhook.
  app.post("/campaigns/:id/retomar-followups", (c) =>
    tratarRetomarFollowups(c.req.raw, c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  return app;
}
