import { Hono } from "hono";
import type { Db } from "../db/port.js";
import { semSegredos } from "../config/redigir.js";
import { tratarWebhookInstantly } from "./handlers/instantly-webhook.js";
import { tratarWebhookCalcom } from "./handlers/calcom-webhook.js";
import {
  tratarProcessarResposta,
  HEADER_SEGREDO_N8N,
} from "./handlers/processar-resposta.js";
import { tratarEnviarLote } from "./handlers/enviar-lote.js";
import { tratarEnriquecerLote } from "./handlers/enriquecer-lote.js";
import { tratarDescobrirEmpresas } from "./handlers/descobrir-empresas.js";
import { tratarRetomarFollowups } from "./handlers/retomar-followups.js";
import { tratarListarCampanhasAtivas } from "./handlers/listar-campanhas-ativas.js";
import { tratarCriarCampanha } from "./handlers/criar-campanha.js";
import { tratarGerarFiltros } from "./handlers/gerar-filtros.js";
import {
  tratarResumoDoPainel,
  tratarLeadsDaCampanha,
  tratarDetalheDoLead,
} from "./handlers/painel.js";
import {
  tratarProporCampanha,
  tratarSalvarProposta,
  tratarAprovarProposta,
} from "./handlers/proposta.js";
import { PAINEL_HTML } from "./painel-html.js";
import {
  tratarLoginDoPainel,
  tratarSaidaDoPainel,
} from "./handlers/painel-sessao.js";
import { sessaoConfere } from "./sessao-painel.js";

export interface DepsDoApp {
  db: Db;
  tenantId: string;
  segredoInstantly: string;
  segredoCalcom: string;
  segredoN8n: string;
  /** `PAINEL_SENHA`. Vazia desliga o painel sem afetar o resto da API. */
  senhaDoPainel: string;
  apiKeyHunter: string;
  apiKeyLusha: string;
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
/**
 * Deixa a requisição do operador logado valer como requisição do n8n.
 *
 * As rotas de negócio conferem o header do n8n, e essa checagem mora dentro de
 * cada handler — que é o que os torna testáveis por invocação direta, sem
 * servidor. Ensinar cada um deles a também entender cookie significaria nove
 * cópias da mesma regra de sessão, e a décima esquecida.
 *
 * Aqui a sessão é trocada pelo segredo uma vez só, na borda: quem apresenta um
 * cookie assinado válido segue adiante como se tivesse mandado o header. Os
 * handlers não mudam e não sabem que o painel existe.
 *
 * O header vindo de fora tem precedência e nunca é sobrescrito — é o n8n
 * falando, e ele não tem cookie nenhum.
 */
async function comoOperador(bruta: Request, deps: DepsDoApp): Promise<Request> {
  if (bruta.headers.get(HEADER_SEGREDO_N8N)) return bruta;
  if (!sessaoConfere(bruta.headers.get("cookie"), deps.senhaDoPainel)) return bruta;

  const headers = new Headers(bruta.headers);
  headers.set(HEADER_SEGREDO_N8N, deps.segredoN8n);

  // O corpo é lido como texto e reanexado, em vez de repassar o fluxo: o
  // Node exige `duplex` para reencaminhar um corpo em streaming, e as rotas
  // do painel mandam no máximo um JSON pequeno.
  const corpo =
    bruta.method === "GET" || bruta.method === "HEAD"
      ? undefined
      : await bruta.text();

  return new Request(bruta.url, { method: bruta.method, headers, body: corpo });
}

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
    c.json({ servico: "prospeccao-b2b", ok: true, saude: "/saude", painel: "/painel" }),
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
  app.post("/campaigns", async (c) =>
    tratarCriarCampanha(await comoOperador(c.req.raw, deps), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // Rota lenta: transforma o nicho em texto livre em filtros estruturados
  // via IA. Chamada uma vez depois de criar a campanha; pode ser repetida
  // sozinha se a IA falhar.
  app.post("/campaigns/:id/gerar-filtros", async (c) =>
    tratarGerarFiltros(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // O começo do funil novo: o propósito da solução vira campanha proposta.
  // Rota lenta e cara (raciocínio alto no modelo), mas repetível à vontade —
  // o resultado é rascunho e só sobrescreve rascunho.
  app.post("/campaigns/:id/propor", async (c) =>
    tratarProporCampanha(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // O refino: grava a proposta editada. Barata, só valida e escreve.
  app.put("/campaigns/:id/proposta", async (c) =>
    tratarSalvarProposta(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // A aprovação: promove o rascunho a campanha e zera os filtros, que foram
  // derivados do nicho anterior. `gerar-filtros` precisa rodar depois.
  app.post("/campaigns/:id/aprovar-proposta", async (c) =>
    tratarAprovarProposta(await comoOperador(c.req.raw, deps), c.req.param("id"), {
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
  app.post("/campaigns/:id/enviar-lote", async (c) =>
    tratarEnviarLote(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // Rota lenta: acha o decisor de cada empresa pendente. O n8n agenda.
  app.post("/campaigns/:id/enriquecer-lote", async (c) =>
    tratarEnriquecerLote(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
      apiKeyHunter: deps.apiKeyHunter,
      apiKeyLusha: deps.apiKeyLusha,
    }),
  );

  // Rota lenta: busca empresas novas na Casa dos Dados a partir do filtro de
  // nicho da campanha. O n8n agenda, antes do lote de enriquecimento.
  app.post("/campaigns/:id/descobrir-empresas", async (c) =>
    tratarDescobrirEmpresas(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
      apiKeyCasaDosDados: deps.apiKeyCasaDosDados,
    }),
  );

  // Rota lenta: reabre contato com os leads cujo "não agora" já venceu o
  // prazo. O n8n agenda — o gatilho é o relógio, não um webhook.
  app.post("/campaigns/:id/retomar-followups", async (c) =>
    tratarRetomarFollowups(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  // A tela do operador. Aberta de propósito: é só o esqueleto HTML, sem
  // nenhum dado dentro. Exigir sessão para servir a página a tornaria
  // inalcançável pelo navegador, que não manda header nem tem cookie antes
  // de existir uma tela onde fazer login. Quem exige sessão são as rotas de
  // dados abaixo.
  app.get("/painel", (c) => c.html(PAINEL_HTML));

  // Troca a senha do operador por um cookie de sessão. Fica fora de
  // `comoOperador` por definição: é a rota que cria a sessão, então exigir
  // sessão aqui seria pedir a chave para entrar na sala onde a chave está.
  app.post("/painel/login", (c) =>
    tratarLoginDoPainel(c.req.raw, { senha: deps.senhaDoPainel }),
  );

  app.post("/painel/sair", () => tratarSaidaDoPainel());

  app.get("/painel/campanhas", async (c) =>
    tratarResumoDoPainel(await comoOperador(c.req.raw, deps), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  app.get("/painel/campanhas/:id/leads", async (c) =>
    tratarLeadsDaCampanha(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  app.get("/painel/leads/:id", async (c) =>
    tratarDetalheDoLead(await comoOperador(c.req.raw, deps), c.req.param("id"), {
      db: deps.db,
      tenantId: deps.tenantId,
      segredo: deps.segredoN8n,
    }),
  );

  return app;
}
