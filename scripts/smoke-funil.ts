/**
 * Smoke test do funil inteiro, do nicho em texto até a reunião marcada.
 *
 * Roda contra um Postgres em memória (PGlite) — não precisa de banco, de
 * Docker nem de Supabase. Cada etapa usa a API de verdade quando a chave
 * correspondente existe no ambiente, e um stub documentado quando não existe.
 * Assim dá para rodar hoje, com zero chave, e ver o encanamento inteiro
 * funcionar; depois é só ir preenchendo o `.env` e rodar de novo.
 *
 * SEGURANÇA: a campanha é criada em `send_mode = shadow` e o script aborta se
 * ela não estiver assim na hora de enviar. Nenhum e-mail sai para ninguém,
 * mesmo com INSTANTLY_API_KEY preenchida — a sombra grava em `messages` o que
 * teria saído, sem chamar fornecedor nenhum.
 *
 *   npm run smoke:funil
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";
import type { Db } from "../src/db/port.js";
import { criarApp } from "../src/api/server.js";
import { gerarFiltros } from "../src/discovery/gerar-filtros.js";
import { enviarLote } from "../src/sending/enviar-lote.js";
import { processarResposta } from "../src/conversation/processar-resposta.js";
import { criarProvedorDeSombra } from "../src/sending/shadow.js";
import { buscarCampanha } from "../src/db/repositories/campaigns.js";
import { transicionarLead } from "../src/db/repositories/leads.js";
import type { NicheFilters } from "../src/ai/niche-parser.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(aqui, "../supabase/migrations/0001_initial_schema.sql");

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const SEGREDO_N8N = "segredo-do-smoke";
const SEGREDO_INSTANTLY = "segredo-instantly-do-smoke";
const SEGREDO_CALCOM = "segredo-calcom-do-smoke";

/** CNPJ público do Banco do Brasil — o CNPJ canônico de teste no Brasil. */
const CNPJ_DE_TESTE = "00000000000191";

const chave = (nome: string) => process.env[nome]?.trim() || null;

const CHAVES = {
  anthropic: chave("ANTHROPIC_API_KEY"),
  casaDosDados: chave("CASA_DOS_DADOS_API_KEY"),
  hunter: chave("HUNTER_API_KEY"),
};

// ───────────────────────────── relatório ─────────────────────────────

const etapas: Array<{ nome: string; modo: string; resumo: string }> = [];

function passo(numero: number, titulo: string) {
  console.log(`\n\x1b[1m${numero}. ${titulo}\x1b[0m`);
}

function registrar(nome: string, modo: string, resumo: string) {
  etapas.push({ nome, modo, resumo });
  const cor = modo.startsWith("real") ? "\x1b[32m" : "\x1b[33m";
  console.log(`   ${cor}[${modo}]\x1b[0m ${resumo}`);
}

// ────────────────────── stubs das APIs externas ──────────────────────

const FILTROS_STUB: NicheFilters = {
  cnaes: ["6422100"],
  ufs: ["DF"],
  cities: [],
  min_employees: null,
  max_employees: null,
  target_roles: ["Gerente de TI"],
  keywords: [],
};

/**
 * Intercepta só os hosts das APIs pagas que não têm chave. A BrasilAPI é
 * gratuita e sem autenticação, então passa sempre direto — é a única perna
 * do enriquecimento que roda de verdade num smoke sem chave nenhuma.
 */
function instalarInterceptador(): void {
  const original = globalThis.fetch;

  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof entrada === "string" ? entrada : entrada.toString();

    if (url.includes("api.casadosdados.com.br") && !CHAVES.casaDosDados) {
      return json({
        total: 1,
        cnpjs: [
          {
            cnpj: CNPJ_DE_TESTE,
            razao_social: "EMPRESA DE TESTE DO SMOKE",
            nome_fantasia: "SMOKE",
            endereco: { uf: "DF", municipio: "BRASILIA" },
          },
        ],
      });
    }

    if (url.includes("api.hunter.io") && !CHAVES.hunter) {
      // A Hunter tem três endpoints com formatos diferentes; o stub precisa
      // responder no formato do que a cadeia realmente chamou.
      if (url.includes("/domain-search")) {
        return json({
          data: {
            emails: [
              {
                value: "maria.souza@bb.com.br",
                first_name: "Maria",
                last_name: "Souza",
                position: "Gerente de TI",
                confidence: 92,
                verification: { status: "valid" },
              },
            ],
          },
        });
      }
      if (url.includes("/email-verifier")) {
        return json({ data: { status: "valid", score: 92 } });
      }
      // email-finder
      return json({
        data: {
          email: "maria.souza@bb.com.br",
          score: 92,
          first_name: "Maria",
          last_name: "Souza",
          position: "Gerente de TI",
          verification: { status: "valid" },
        },
      });
    }

    return original(entrada, init);
  }) as typeof fetch;
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });

// ─────────────────────────── infraestrutura ───────────────────────────

async function subirBanco(): Promise<Db> {
  const pglite = new PGlite();
  await pglite.exec(readFileSync(MIGRATION, "utf8"));
  const db: Db = pglite;
  await db.query(`insert into tenants (id, name) values ($1, $2)`, [
    TENANT_ID,
    "SQL Tech",
  ]);
  return db;
}

function pedir(
  app: ReturnType<typeof criarApp>,
  caminho: string,
  opcoes: { metodo?: string; corpo?: unknown; headers?: Record<string, string> } = {},
) {
  return app.request(caminho, {
    method: opcoes.metodo ?? "POST",
    headers: {
      "content-type": "application/json",
      "x-prospeccao-segredo": SEGREDO_N8N,
      ...opcoes.headers,
    },
    body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
  });
}

// ───────────────────────────── o funil ─────────────────────────────

async function main() {
  instalarInterceptador();

  console.log("\x1b[1m\nSmoke do funil — Postgres em memória, modo sombra\x1b[0m");
  console.log(
    `Chaves detectadas: Anthropic ${CHAVES.anthropic ? "✓" : "✗"} · ` +
      `Casa dos Dados ${CHAVES.casaDosDados ? "✓" : "✗"} · ` +
      `Hunter ${CHAVES.hunter ? "✓" : "✗"} · BrasilAPI ✓ (grátis)`,
  );

  const db = await subirBanco();
  const app = criarApp({
    db,
    tenantId: TENANT_ID,
    segredoInstantly: SEGREDO_INSTANTLY,
    segredoCalcom: SEGREDO_CALCOM,
    segredoN8n: SEGREDO_N8N,
    senhaDoPainel: "senha-do-painel",
    apiKeyHunter: CHAVES.hunter ?? "chave-stub",
    apiKeyLusha: "",
    apiKeyCasaDosDados: CHAVES.casaDosDados ?? "chave-stub",
  });

  // 1 ─ criar a campanha a partir do nicho em texto livre
  passo(1, "Criar campanha (POST /campaigns)");
  const resCampanha = await pedir(app, "/campaigns", {
    corpo: {
      name: "Smoke — bancos em Brasília",
      nicheDescription:
        "bancos e instituições financeiras em Brasília, quero falar com o gerente de TI",
      offerDescription: "Consultoria de dados e BI para o setor financeiro",
      schedulingLink: "https://cal.com/thiago/30min",
      senderFirstName: "Thiago",
    },
  });
  if (resCampanha.status !== 201) {
    throw new Error(`Falhou ao criar campanha: ${await resCampanha.text()}`);
  }
  const campanha = (await resCampanha.json()) as { id: string; send_mode: string };
  registrar("criar campanha", "real", `campanha ${campanha.id.slice(0, 8)}… criada`);

  if (campanha.send_mode !== "shadow") {
    throw new Error(
      `ABORTADO: campanha nasceu em "${campanha.send_mode}", esperado "shadow".`,
    );
  }

  // 2 ─ nicho em texto → filtros estruturados (IA)
  passo(2, "Gerar filtros do nicho (IA)");
  if (CHAVES.anthropic) {
    const res = await pedir(app, `/campaigns/${campanha.id}/gerar-filtros`);
    const corpo = (await res.json()) as { gerado: boolean; filtros?: NicheFilters };
    if (!corpo.gerado) throw new Error(`IA falhou: ${JSON.stringify(corpo)}`);
    registrar(
      "gerar filtros",
      "real (HTTP + Claude)",
      `CNAEs ${JSON.stringify(corpo.filtros!.cnaes)}, UFs ${JSON.stringify(corpo.filtros!.ufs)}, cargos ${JSON.stringify(corpo.filtros!.target_roles)}`,
    );
  } else {
    const resultado = await gerarFiltros(
      { db, tenantId: TENANT_ID, campaignId: campanha.id },
      { parseNiche: async () => FILTROS_STUB },
    );
    if (!resultado.gerado) throw new Error(resultado.motivo);
    registrar(
      "gerar filtros",
      "stub (sem ANTHROPIC_API_KEY)",
      `filtros fixos: CNAE ${FILTROS_STUB.cnaes[0]}, UF ${FILTROS_STUB.ufs[0]}`,
    );
  }

  // 3 ─ descobrir empresas
  passo(3, "Descobrir empresas (POST /campaigns/:id/descobrir-empresas)");
  const resDescoberta = await pedir(
    app,
    `/campaigns/${campanha.id}/descobrir-empresas`,
  );
  const descoberta = (await resDescoberta.json()) as {
    encontradas: number;
    salvas: number;
    motivo: string;
  };
  registrar(
    "descobrir empresas",
    CHAVES.casaDosDados ? "real (Casa dos Dados)" : "stub (sem CASA_DOS_DADOS_API_KEY)",
    descoberta.motivo,
  );
  if (descoberta.salvas === 0) {
    throw new Error("Nenhuma empresa salva — o resto do funil não tem o que processar.");
  }

  // 4 ─ enriquecer: achar o decisor de cada empresa
  passo(4, "Enriquecer decisores (POST /campaigns/:id/enriquecer-lote)");
  const resEnriquecimento = await pedir(
    app,
    `/campaigns/${campanha.id}/enriquecer-lote`,
  );
  const enriquecimento = (await resEnriquecimento.json()) as {
    encontrados: number;
    motivo: string;
  };
  registrar(
    "enriquecer",
    CHAVES.hunter ? "real (BrasilAPI + Hunter)" : "real BrasilAPI + stub Hunter",
    enriquecimento.motivo,
  );

  const { rows: leads } = await db.query<{ id: string; email: string; stage: string }>(
    `select id, email, stage from leads where tenant_id = $1`,
    [TENANT_ID],
  );
  if (leads.length === 0) {
    throw new Error("Nenhum lead criado — sem lead não há e-mail para enviar.");
  }
  const lead = leads[0]!;
  console.log(`   → lead: ${lead.email} (estágio ${lead.stage})`);

  // 5 ─ primeiro e-mail, sempre em sombra
  passo(5, "Enviar primeiro e-mail (modo SOMBRA — nada sai de verdade)");
  const relida = await buscarCampanha(db, TENANT_ID, campanha.id);
  if (relida?.send_mode !== "shadow") {
    throw new Error(`ABORTADO: send_mode virou "${relida?.send_mode}".`);
  }
  if (CHAVES.anthropic) {
    const res = await pedir(app, `/campaigns/${campanha.id}/enviar-lote`);
    const corpo = (await res.json()) as { motivo: string };
    registrar("primeiro e-mail", "real (HTTP + Claude, sombra)", corpo.motivo);
  } else {
    const resultado = await enviarLote(
      {
        db,
        tenantId: TENANT_ID,
        campaignId: campanha.id,
        provedor: criarProvedorDeSombra(db),
      },
      {
        escreverEmail: async () => ({
          subject: "Integração de dados na sua operação",
          body: "Olá Maria, vi que vocês...\n\nSe preferir não receber mais contato, é só responder pedindo.\n\nThiago",
        }),
      },
    );
    registrar("primeiro e-mail", "stub de IA + sombra real", resultado.motivo);
  }

  // 5b ─ em sombra o estágio NÃO avança (decisão de projeto: o ensaio não pode
  // queimar a fila de leads, porque `contacted → enriched` não existe no
  // funil). Como os passos seguintes exercitam a metade de conversa, avançamos
  // à mão exatamente o que um envio real teria avançado — e só isso.
  passo(5.5, "Simular o avanço que um envio real faria");
  await transicionarLead(db, TENANT_ID, lead.id, "contacted");
  registrar(
    "avanço manual",
    "simulado",
    "lead movido para 'contacted' — em sombra o envio real não faz isso de propósito",
  );

  // 6 ─ o lead responde (webhook do Instantly)
  passo(6, "Lead responde (POST /webhooks/instantly)");
  const resWebhook = await app.request("/webhooks/instantly", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-prospeccao-segredo": SEGREDO_INSTANTLY,
    },
    body: JSON.stringify({
      event_type: "reply_received",
      lead_email: lead.email,
      email_id: "evt_smoke_resposta_1",
      reply_subject: "Re: Integração de dados",
      reply_text: "Interessante! Podemos marcar uma conversa na semana que vem?",
    }),
  });
  registrar(
    "webhook de resposta",
    "real",
    `HTTP ${resWebhook.status} — resposta gravada, sem chamar IA (como manda o desenho)`,
  );

  // 7 ─ classificar e responder
  passo(7, "Classificar e responder (POST /leads/:id/processar-resposta)");
  if (CHAVES.anthropic) {
    const res = await pedir(app, `/leads/${lead.id}/processar-resposta`);
    const corpo = (await res.json()) as { acao?: string; motivo?: string };
    registrar(
      "processar resposta",
      "real (HTTP + Claude, sombra)",
      `ação decidida: ${corpo.acao ?? corpo.motivo}`,
    );
  } else {
    const resultado = await processarResposta(
      {
        db,
        tenantId: TENANT_ID,
        leadId: lead.id,
        provedor: criarProvedorDeSombra(db),
      },
      {
        classificar: async () => ({
          intent: "interested",
          confidence: 0.95,
          reasoning: "pediu para marcar conversa",
          key_points: [],
          suggested_resume_days: null,
        }),
        escreverReply: async () => ({
          subject: "Re: Integração de dados",
          body: "Que bom! Escolha um horário aqui: https://cal.com/thiago/30min\n\nThiago",
        }),
      },
    );
    registrar(
      "processar resposta",
      "stub de IA + sombra real",
      `ação decidida: ${"acao" in resultado ? resultado.acao : resultado.motivo}`,
    );
  }

  // 8 ─ reunião marcada (webhook do Cal.com)
  passo(8, "Reunião marcada (POST /webhooks/calcom)");
  const corpoCalcom = JSON.stringify({
    triggerEvent: "BOOKING_CREATED",
    payload: {
      uid: "booking_smoke_1",
      startTime: "2026-09-15T14:00:00.000Z",
      type: "30min",
      attendees: [{ email: lead.email, name: "Maria Souza" }],
    },
  });
  const resCalcom = await app.request("/webhooks/calcom", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cal-signature-256": createHmac("sha256", SEGREDO_CALCOM)
        .update(corpoCalcom)
        .digest("hex"),
    },
    body: corpoCalcom,
  });
  registrar("webhook de agendamento", "real", `HTTP ${resCalcom.status}`);

  // ───────────────────────── resultado final ─────────────────────────

  const { rows: finais } = await db.query<{ stage: string; email: string }>(
    `select stage, email from leads where tenant_id = $1`,
    [TENANT_ID],
  );
  const { rows: mensagens } = await db.query<{
    direction: string;
    shadow: boolean;
    subject: string | null;
  }>(
    `select direction, shadow, subject from messages where tenant_id = $1 order by created_at`,
    [TENANT_ID],
  );
  const { rows: eventos } = await db.query<{ kind: string; total: number }>(
    `select kind, count(*)::int as total from events where tenant_id = $1
     group by kind order by kind`,
    [TENANT_ID],
  );

  console.log("\n\x1b[1m─── Resultado ───\x1b[0m");
  console.log(`\nLead final: ${finais[0]?.email} → estágio \x1b[1m${finais[0]?.stage}\x1b[0m`);

  console.log(`\nMensagens gravadas (${mensagens.length}):`);
  for (const m of mensagens) {
    const rotulo = m.direction === "outbound" ? "nós →" : "← lead";
    const sombra = m.shadow ? " \x1b[33m[sombra: NÃO saiu]\x1b[0m" : "";
    console.log(`  ${rotulo} ${m.subject ?? "(sem assunto)"}${sombra}`);
  }

  console.log("\nEventos de auditoria:");
  for (const e of eventos) console.log(`  ${e.total}× ${e.kind}`);

  const saiuDeVerdade = mensagens.filter((m) => m.direction === "outbound" && !m.shadow);
  console.log(
    `\n\x1b[1mE-mails que saíram de verdade: ${saiuDeVerdade.length}\x1b[0m` +
      (saiuDeVerdade.length === 0 ? " \x1b[32m✓ (como esperado em sombra)\x1b[0m" : " \x1b[31m✗ ERRO\x1b[0m"),
  );

  const stubs = etapas.filter((e) => e.modo.includes("stub"));
  if (stubs.length > 0) {
    console.log(
      `\n\x1b[33mEtapas em stub (${stubs.length}): ${stubs.map((e) => e.nome).join(", ")}\x1b[0m`,
    );
    console.log("Preencha as chaves no .env e rode de novo para exercitá-las de verdade.");
  }

  const chegou = finais[0]?.stage === "meeting_booked";
  console.log(
    chegou
      ? "\n\x1b[32m✓ Funil completo: do nicho em texto até a reunião marcada.\x1b[0m\n"
      : `\n\x1b[31m✗ O lead parou em "${finais[0]?.stage}".\x1b[0m\n`,
  );
  process.exit(chegou ? 0 : 1);
}

main().catch((erro) => {
  console.error(`\n\x1b[31m✗ ${erro instanceof Error ? erro.message : erro}\x1b[0m\n`);
  process.exit(1);
});
