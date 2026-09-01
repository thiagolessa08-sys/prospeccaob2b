/**
 * A tela do operador, embutida como string.
 *
 * Embutida, e não servida de um `.html` no disco, porque o build é `tsc`: ele
 * emite só o JavaScript para `dist/`, e um arquivo estático ficaria para trás
 * — a página sumiria em produção e funcionaria em desenvolvimento, que é o
 * pior jeito de descobrir o problema. É o mesmo motivo que fez a migration
 * precisar de `caminho-migration.ts`.
 *
 * Servida pelo próprio Hono, na mesma origem da API, de propósito: não há CORS
 * no servidor, então uma página hospedada em qualquer outro lugar não
 * conseguiria chamar rota nenhuma daqui.
 *
 * Sem dependência externa — nenhuma fonte, nenhum CDN. A tela precisa abrir
 * dentro de uma rede corporativa que bloqueia o que não conhece.
 */
export const PAINEL_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prospecção B2B — Painel</title>
<style>
  :root {
    --fundo: #f6f7f9; --papel: #fff; --borda: #dfe3e8; --texto: #14181d;
    --fraco: #626c78; --acento: #1f6feb; --ok: #1a7f37; --alerta: #9a6700;
    --erro: #cf222e; --codigo: #f0f2f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fundo: #0d1117; --papel: #161b22; --borda: #30363d; --texto: #e6edf3;
      --fraco: #9198a1; --acento: #4493f8; --ok: #3fb950; --alerta: #d29922;
      --erro: #f85149; --codigo: #0d1117;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fundo); color: var(--texto);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    padding: 14px 20px; background: var(--papel);
    border-bottom: 1px solid var(--borda); position: sticky; top: 0; z-index: 10;
  }
  header h1 { font-size: 16px; margin: 0; margin-right: auto; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em;
       color: var(--fraco); margin: 28px 0 10px; }
  input, select, textarea, button {
    font: inherit; color: inherit; border-radius: 6px;
    border: 1px solid var(--borda); background: var(--papel); padding: 7px 10px;
  }
  input, textarea { width: 100%; }
  button { cursor: pointer; background: var(--papel); }
  button:hover:not(:disabled) { border-color: var(--acento); color: var(--acento); }
  button:disabled { opacity: .5; cursor: progress; }
  button.principal { background: var(--acento); border-color: var(--acento); color: #fff; }
  button.principal:hover:not(:disabled) { color: #fff; opacity: .9; }
  .cartao {
    background: var(--papel); border: 1px solid var(--borda);
    border-radius: 10px; padding: 16px; margin-bottom: 12px;
  }
  .linha { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .campos { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
  .campos label { display: block; font-size: 13px; color: var(--fraco); }
  .campos .largo { grid-column: 1 / -1; }
  .etiqueta {
    font-size: 12px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--borda); color: var(--fraco);
  }
  .numeros { display: flex; gap: 18px; flex-wrap: wrap; margin: 12px 0; }
  .numeros div { font-size: 12px; color: var(--fraco); }
  .numeros b { display: block; font-size: 20px; color: var(--texto); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--borda); }
  th { font-size: 12px; color: var(--fraco); text-transform: uppercase; }
  tbody tr[data-lead] { cursor: pointer; }
  tbody tr[data-lead]:hover { background: var(--codigo); }
  pre {
    background: var(--codigo); border: 1px solid var(--borda); border-radius: 6px;
    padding: 10px; overflow-x: auto; font-size: 12px; margin: 8px 0 0;
    white-space: pre-wrap; word-break: break-word;
  }
  .rolagem { overflow-x: auto; }
  .msg { border-left: 3px solid var(--borda); padding: 4px 0 4px 12px; margin: 12px 0; }
  .msg.saida { border-color: var(--acento); }
  .msg .quem { font-size: 12px; color: var(--fraco); margin-bottom: 4px; }
  .msg .corpo { white-space: pre-wrap; }
  .aviso { color: var(--erro); }
  .vazio { color: var(--fraco); font-style: italic; }
  dialog {
    width: min(760px, 92vw); max-height: 86vh; border: 1px solid var(--borda);
    border-radius: 12px; background: var(--papel); color: var(--texto); padding: 20px;
  }
  dialog::backdrop { background: rgba(0,0,0,.5); }
  @media (max-width: 620px) { .campos { grid-template-columns: 1fr; } }
</style>
</head>
<body>

<header>
  <h1>Prospecção B2B</h1>
  <input id="senha" type="password" placeholder="Senha do painel" style="width:220px"
         autocomplete="current-password">
  <button id="entrar" class="principal">Entrar</button>
  <button id="recarregar" hidden>Recarregar</button>
  <button id="sair" hidden>Sair</button>
</header>

<main>
  <p id="estado" class="vazio">Entre com a senha do painel.</p>

  <section id="conteudo" hidden>
    <h2>Nova campanha</h2>
    <div class="cartao">
      <div class="campos">
        <label>Nome da campanha<input id="f-name" placeholder="Ind&uacute;strias SC"></label>
        <label>Seu primeiro nome<input id="f-sender" placeholder="Thiago"></label>
        <label class="largo">Para que serve a solu&ccedil;&atilde;o que voc&ecirc; vende
          <textarea id="f-proposito" rows="3"
            placeholder="Descreva o problema que a solu&ccedil;&atilde;o resolve e para quem. A IA deriva daqui o nicho, os cargos e o discurso do e-mail &mdash; e voc&ecirc; refina antes de qualquer disparo."></textarea></label>
        <label class="largo">Link de agendamento<input id="f-link" placeholder="https://cal.com/thiago/30min"></label>
      </div>
      <div class="linha" style="margin-top:12px">
        <button id="criar" class="principal">Criar campanha</button>
        <span id="criar-msg" class="vazio"></span>
      </div>
    </div>

    <h2>Campanhas</h2>
    <div id="campanhas"></div>
  </section>
</main>

<dialog id="detalhe">
  <div id="detalhe-corpo"></div>
  <div style="margin-top:16px"><button id="fechar-detalhe">Fechar</button></div>
</dialog>

<dialog id="proposta">
  <h3 style="margin:0 0 4px">Proposta da campanha</h3>
  <p class="vazio" style="margin:0 0 16px">
    Tudo aqui &eacute; edit&aacute;vel. Nada afeta o funil at&eacute; voc&ecirc; aprovar.
  </p>
  <div class="campos">
    <label class="largo">Nicho &mdash; as empresas que vamos procurar
      <textarea id="p-nicho" rows="3"></textarea></label>
    <label class="largo">Oferta &mdash; o que entregamos
      <textarea id="p-oferta" rows="2"></textarea></label>
    <label class="largo">Cargos do decisor <span class="vazio">(um por linha)</span>
      <textarea id="p-cargos" rows="3"></textarea></label>
    <label class="largo">&Acirc;ngulo da abordagem
      <textarea id="p-angulo" rows="2"></textarea></label>
    <label class="largo">Dores <span class="vazio">(uma por linha)</span>
      <textarea id="p-dores" rows="3"></textarea></label>
    <label class="largo">Provas <span class="vazio">(uma por linha)</span>
      <textarea id="p-provas" rows="3"></textarea></label>
    <label class="largo">N&atilde;o dizer <span class="vazio">(um por linha)</span>
      <textarea id="p-evitar" rows="3"></textarea></label>
  </div>

  <h2>E-mail de amostra</h2>
  <p class="vazio" style="margin:0 0 8px">
    S&oacute; para voc&ecirc; julgar o tom. N&atilde;o &eacute; este texto que sai:
    o funil escreve um e-mail por lead seguindo o briefing acima.
  </p>
  <div class="campos">
    <label class="largo">Assunto<input id="p-assunto"></label>
    <label class="largo">Corpo<textarea id="p-corpo" rows="8"></textarea></label>
  </div>

  <div class="linha" style="margin-top:16px">
    <button id="p-salvar">Salvar rascunho</button>
    <button id="p-aprovar" class="principal">Aprovar e usar</button>
    <button id="p-fechar">Fechar</button>
    <span id="p-msg" class="vazio"></span>
  </div>
</dialog>

<script>
"use strict";

var ROTAS = [
  { rota: "gerar-filtros", nome: "Gerar filtros" },
  { rota: "descobrir-empresas", nome: "Descobrir empresas" },
  { rota: "enriquecer-lote", nome: "Enriquecer" },
  { rota: "enviar-lote", nome: "Enviar" },
  { rota: "retomar-followups", nome: "Retomar follow-ups" }
];

var ESTAGIOS = [
  ["discovered", "Descobertos"], ["enriched", "Enriquecidos"],
  ["contacted", "Contatados"], ["in_conversation", "Em conversa"],
  ["meeting_booked", "Reuni&otilde;es"], ["discarded", "Descartados"], ["error", "Erro"]
];

function $(id) { return document.getElementById(id); }

function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/**
 * Nao ha credencial guardada nesta pagina: a sessao vive num cookie HttpOnly,
 * que o JavaScript daqui nao consegue ler nem escrever. O navegador o reenvia
 * sozinho em toda chamada de mesma origem, entao nao ha nada a anexar aqui.
 *
 * Toda chamada passa por esta funcao para o 401 ter um unico tratamento:
 * sessao expirada ou ausente devolve o operador para a tela de entrada, em vez
 * de deixar a pagina tentando de novo para sempre.
 */
async function api(caminho, opcoes) {
  opcoes = opcoes || {};
  var cabecalhos = {};
  if (opcoes.body) cabecalhos["content-type"] = "application/json";

  var res = await fetch(caminho, {
    method: opcoes.method || "GET",
    headers: cabecalhos,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined
  });

  if (res.status === 401) {
    mostrarEntrada("Sess&atilde;o expirada. Entre de novo.");
    throw new Error("401");
  }

  var texto = await res.text();
  var corpo;
  try { corpo = JSON.parse(texto); } catch (e) { corpo = texto; }
  if (!res.ok) throw new Error(typeof corpo === "string" ? corpo : JSON.stringify(corpo));
  return corpo;
}

function mostrarEntrada(aviso) {
  $("conteudo").hidden = true;
  $("estado").hidden = false;
  $("estado").innerHTML = aviso || "Entre com a senha do painel.";
  $("estado").className = aviso ? "aviso" : "vazio";
  $("senha").hidden = false;
  $("entrar").hidden = false;
  $("recarregar").hidden = true;
  $("sair").hidden = true;
}

function mostrarPainel() {
  $("senha").hidden = true;
  $("entrar").hidden = true;
  $("recarregar").hidden = false;
  $("sair").hidden = false;
}

function dataCurta(iso) {
  if (!iso) return "&mdash;";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "&mdash;";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

async function carregar() {
  $("estado").hidden = false;
  $("estado").className = "vazio";
  $("estado").textContent = "Carregando...";

  var campanhas;
  try {
    campanhas = await api("/painel/campanhas");
  } catch (e) {
    if (e.message !== "401") mostrarEntrada("Falha ao carregar: " + esc(e.message));
    return;
  }

  $("estado").hidden = true;
  $("conteudo").hidden = false;
  mostrarPainel();
  desenharCampanhas(campanhas);
}

// A ultima lista carregada. O editor de proposta le daqui em vez de buscar de
// novo: carregar() ja traz a proposta inteira junto de cada campanha.
//
// Sem crase neste comentario, de proposito: ele vive DENTRO do template
// literal de painel-html.ts, e uma crase aqui o fecha antes da hora. Ja
// quebrou o build uma vez (commit 4485a8c) e quebrou de novo aqui.
var campanhasEmTela = [];

function desenharCampanhas(campanhas) {
  campanhasEmTela = campanhas;
  var alvo = $("campanhas");
  if (!campanhas.length) {
    alvo.innerHTML = '<p class="vazio">Nenhuma campanha ainda. Crie a primeira acima.</p>';
    return;
  }

  var html = "";
  for (var i = 0; i < campanhas.length; i++) {
    var c = campanhas[i];
    html += '<div class="cartao">';
    html += '<div class="linha"><strong>' + esc(c.name) + "</strong>";
    html += '<span class="etiqueta">' + esc(c.status) + "</span>";
    html += '<span class="etiqueta">' + esc(c.send_mode) + "</span>";
    html += c.tem_filtros
      ? '<span class="etiqueta">filtros ok</span>'
      : '<span class="etiqueta" style="color:var(--alerta)">sem filtros</span>';
    if (c.proposta_aprovada_em) {
      html += '<span class="etiqueta" style="color:var(--ok)">proposta aprovada</span>';
    } else if (c.tem_proposta) {
      html += '<span class="etiqueta" style="color:var(--alerta)">proposta em revis&atilde;o</span>';
    } else {
      html += '<span class="etiqueta" style="color:var(--alerta)">sem proposta</span>';
    }
    html += "</div>";
    html += '<div style="color:var(--fraco);font-size:13px;margin-top:6px">' + esc(c.niche_description) + "</div>";

    html += '<div class="numeros">';
    html += "<div>Empresas pendentes<b>" + c.empresas.pending + "</b></div>";
    html += "<div>Enriquecidas<b>" + c.empresas.enriched + "</b></div>";
    html += "<div>Sem decisor<b>" + c.empresas.failed + "</b></div>";
    for (var j = 0; j < ESTAGIOS.length; j++) {
      html += "<div>" + ESTAGIOS[j][1] + "<b>" + c.leads[ESTAGIOS[j][0]] + "</b></div>";
    }
    html += "</div>";

    html += '<div class="linha" style="margin-bottom:10px">';
    html += '<button data-propor="' + esc(c.id) + '">'
      + (c.tem_proposta ? "Propor de novo" : "Propor com IA") + "</button>";
    if (c.tem_proposta) {
      html += '<button data-proposta="' + esc(c.id) + '" class="'
        + (c.proposta_aprovada_em ? "" : "principal") + '">Revisar proposta</button>';
    }
    html += "</div>";

    html += desenharFiltros(c.filtros);

    html += '<div class="linha">';
    for (var k = 0; k < ROTAS.length; k++) {
      html += '<button data-acao="' + ROTAS[k].rota + '" data-id="' + esc(c.id) + '">' + ROTAS[k].nome + "</button>";
    }
    html += '<button data-empresas="' + esc(c.id) + '">Ver empresas</button>';
    html += '<button data-leads="' + esc(c.id) + '">Ver leads</button>';
    html += '<button data-eventos="' + esc(c.id) + '">Ver eventos</button>';
    html += "</div>";
    html += '<div id="saida-' + esc(c.id) + '"></div>';
    html += '<div id="leads-' + esc(c.id) + '"></div>';
    html += "</div>";
  }
  alvo.innerHTML = html;
}

/**
 * Mostra os filtros que a IA gerou, e nao so "tem filtros".
 *
 * Um botao que responde "pronto" sem dizer o que fez obriga a abrir o banco
 * para conferir. Os campos que a Casa dos Dados NAO usa para filtrar ficam
 * marcados: sem isso, ler "SAP" na lista faz parecer que a busca vai
 * restringir por ERP, quando ela nao tem esse dado.
 */
function desenharFiltros(f) {
  if (!f) return "";

  var partes = "";
  partes += chips("CNAEs", f.cnaes);
  partes += chips("UFs", f.ufs);
  partes += chips("Cidades", f.cities);

  var porte = [];
  if (f.min_employees) porte.push("min " + f.min_employees);
  if (f.max_employees) porte.push("max " + f.max_employees);
  if (porte.length) partes += chips("Funcion&aacute;rios", porte);

  partes += chips("Cargos-alvo", f.target_roles);
  partes += chips("Palavras-chave (n&atilde;o filtram a busca)", f.keywords);

  if (!partes) return "";
  return '<div class="cartao" style="margin:10px 0;background:var(--codigo)">' + partes + "</div>";
}

function chips(titulo, itens) {
  if (!itens || !itens.length) return "";
  var html = '<div style="margin-bottom:6px"><span class="vazio" style="font-size:12px">'
    + titulo + ":</span> ";
  for (var i = 0; i < itens.length; i++) {
    html += '<span class="etiqueta" style="margin-right:4px">' + esc(itens[i]) + "</span>";
  }
  return html + "</div>";
}

/**
 * O retorno de cada rota em portugues, e nao o JSON cru.
 *
 * Os handlers ja devolvem um campo "motivo" escrito para humano. O JSON
 * completo continua disponivel, recolhido, para quando algo nao bate.
 */
function resultadoLegivel(r) {
  if (!r || typeof r !== "object") return "<pre>" + esc(String(r)) + "</pre>";

  var linha = "";
  if (typeof r.motivo === "string") linha = esc(r.motivo);
  else if (r.gerado === false || r.proposto === false) linha = esc(r.erro || "não deu certo");
  else if (typeof r.erro === "string") linha = esc(r.erro);

  var detalhe = "<details><summary class=\\"vazio\\" style=\\"cursor:pointer;font-size:12px\\">"
    + "ver resposta completa</summary><pre>" + esc(JSON.stringify(r, null, 2)) + "</pre></details>";

  return (linha ? '<p style="margin:8px 0 0">' + linha + "</p>" : "") + detalhe;
}

/**
 * As cinco rotas de lote sao lentas e caras - enriquecimento e envio gastam
 * credito de fornecedor. O botao desabilita enquanto a chamada corre para o
 * duplo clique nao virar duas cobrancas.
 */
async function dispararAcao(botao, id, rota) {
  var saida = $("saida-" + id);
  botao.disabled = true;
  saida.innerHTML = "<pre>Rodando " + esc(rota) + "...</pre>";
  try {
    var r = await api("/campaigns/" + id + "/" + rota, { method: "POST" });
    saida.innerHTML = resultadoLegivel(r);
    await carregar();
    // carregar() redesenha os cartoes e apaga a saida. Repor depois e o que
    // deixa a resposta na tela junto dos numeros ja atualizados.
    var novaSaida = $("saida-" + id);
    if (novaSaida) novaSaida.innerHTML = resultadoLegivel(r);
  } catch (e) {
    if (e.message !== "401") {
      var alvo = $("saida-" + id);
      if (alvo) alvo.innerHTML = '<pre class="aviso">' + esc(e.message) + "</pre>";
    }
  } finally {
    botao.disabled = false;
  }
}

/**
 * A trilha da campanha: o que cada acao registrou, incluindo as falhas.
 *
 * E a tela que responde "por que nao funcionou". Antes, uma falha na busca da
 * Casa dos Dados dizia so "falha na busca" e o motivo real ficava no banco.
 */
async function verEventos(id) {
  var alvo = $("leads-" + id);
  alvo.innerHTML = '<p class="vazio">Carregando eventos...</p>';
  var eventos;
  try {
    eventos = await api("/painel/campanhas/" + id + "/eventos");
  } catch (e) {
    if (e.message !== "401") alvo.innerHTML = '<p class="aviso">' + esc(e.message) + "</p>";
    return;
  }

  if (!eventos.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum evento nesta campanha ainda.</p>';
    return;
  }

  var html = '<div class="rolagem"><table><thead><tr><th>Quando</th><th>O qu&ecirc;</th>';
  html += "<th>Detalhe</th></tr></thead><tbody>";

  for (var i = 0; i < eventos.length; i++) {
    var ev = eventos[i];
    var p = ev.payload || {};
    // A falha guarda o motivo em "erro"; a tentativa guarda contagens. Mostrar
    // o texto quando existe evita obrigar a ler JSON para achar a causa.
    var resumo = p.erro || p.motivo || "";
    var falhou = ev.kind.indexOf("falha") === 0;

    html += "<tr><td>" + dataCurta(ev.created_at) + "</td>";
    html += '<td style="color:' + (falhou ? "var(--erro)" : "var(--fraco)") + '">';
    html += esc(ev.kind) + "</td><td>";
    if (resumo) html += '<div style="margin-bottom:4px">' + esc(resumo) + "</div>";
    html += '<details><summary class="vazio" style="cursor:pointer;font-size:12px">';
    html += "ver payload</summary><pre style=\\"margin:4px 0 0\\">";
    html += esc(JSON.stringify(p, null, 2)) + "</pre></details>";
    html += "</td></tr>";
  }

  alvo.innerHTML = html + "</tbody></table></div>";
}

/**
 * O que cada fonte respondeu, dentro da tentativa de uma empresa.
 *
 * O motivo devolvido pela cadeia e o resumo: "Nenhum decisor com e-mail
 * utilizavel" cobre tanto "a Hunter procurou e nao achou" quanto "a Hunter
 * recusou a chave com 401". A cadeia captura o erro de cada fonte, segue para
 * a proxima e guarda o que houve aqui — sem mostrar, o diagnostico para no
 * resumo e a causa real fica no banco.
 *
 * E tambem por onde aparece o "Forma recebida: ..." do adaptador da Lusha,
 * que e como se descobre um nome de campo errado sem ter a resposta real dela
 * em maos.
 */
function desenharTentativas(tentativas) {
  if (!tentativas || !tentativas.length) return "";

  var html = '<details style="margin-top:4px">';
  html += '<summary class="vazio" style="cursor:pointer;font-size:12px">';
  html += tentativas.length + " tentativa(s) por fonte</summary>";
  html += '<div style="font-size:12px;margin-top:4px">';

  for (var i = 0; i < tentativas.length; i++) {
    var t = tentativas[i] || {};
    var ruim = t.resultado === "erro";
    html += '<div style="margin-bottom:2px">';
    html += '<span class="etiqueta">' + esc(t.fonte) + "</span> ";
    html += '<span style="color:' + (ruim ? "var(--erro)" : "var(--fraco)") + '">';
    html += esc(t.resultado) + "</span>";
    if (t.detalhe) html += ' <span class="vazio">' + esc(t.detalhe) + "</span>";
    html += "</div>";
  }

  return html + "</div></details>";
}

/** Empresas descobertas, com o motivo de quem ficou sem decisor. */
async function verEmpresas(id) {
  var alvo = $("leads-" + id);
  alvo.innerHTML = '<p class="vazio">Carregando empresas...</p>';
  var empresas;
  try {
    empresas = await api("/painel/campanhas/" + id + "/empresas");
  } catch (e) {
    if (e.message !== "401") alvo.innerHTML = '<p class="aviso">' + esc(e.message) + "</p>";
    return;
  }

  if (!empresas.length) {
    alvo.innerHTML = '<p class="vazio">Nenhuma empresa ainda. Rode Descobrir empresas.</p>';
    return;
  }

  var html = '<div class="rolagem"><table><thead><tr><th>Empresa</th><th>CNPJ</th>';
  html += "<th>Cidade/UF</th><th>Func.</th><th>Status</th><th>Por qu&ecirc;</th>";
  html += "</tr></thead><tbody>";

  for (var i = 0; i < empresas.length; i++) {
    var e = empresas[i];
    var t = e.ultima_tentativa || {};
    var cor =
      e.enrichment_status === "enriched" ? "var(--ok)" :
      e.enrichment_status === "failed" ? "var(--erro)" : "var(--fraco)";

    html += "<tr>";
    html += "<td>" + esc(e.trade_name || e.legal_name) + "</td>";
    html += "<td>" + esc(e.cnpj || "—") + "</td>";
    html += "<td>" + esc([e.city, e.uf].filter(Boolean).join("/") || "—") + "</td>";
    html += "<td>" + (e.employee_count === null ? "—" : e.employee_count) + "</td>";
    html += '<td style="color:' + cor + '">' + esc(e.enrichment_status) + "</td>";
    html += "<td>" + esc(t.motivo || (e.enrichment_status === "pending" ? "ainda não tentada" : "—"));
    if (t.provedor) html += ' <span class="etiqueta">' + esc(t.provedor) + "</span>";
    html += desenharTentativas(t.tentativas);
    html += "</td></tr>";
  }

  alvo.innerHTML = html + "</tbody></table></div>";
}

async function verLeads(id) {
  var alvo = $("leads-" + id);
  alvo.innerHTML = '<p class="vazio">Carregando leads...</p>';
  var leads;
  try {
    leads = await api("/painel/campanhas/" + id + "/leads");
  } catch (e) {
    if (e.message !== "401") alvo.innerHTML = '<p class="aviso">' + esc(e.message) + "</p>";
    return;
  }

  if (!leads.length) {
    alvo.innerHTML = '<p class="vazio">Nenhum lead nesta campanha ainda.</p>';
    return;
  }

  var html = '<div class="rolagem"><table><thead><tr><th>Empresa</th><th>Decisor</th>';
  html += "<th>E-mail</th><th>Est&aacute;gio</th><th>Trocas</th><th>Atualizado</th></tr></thead><tbody>";
  for (var i = 0; i < leads.length; i++) {
    var l = leads[i];
    html += '<tr data-lead="' + esc(l.id) + '">';
    html += "<td>" + esc(l.empresa) + "</td>";
    html += "<td>" + esc(l.full_name || "—") + "</td>";
    html += "<td>" + esc(l.email) + "</td>";
    html += "<td>" + esc(l.stage);
    if (l.needs_human) html += ' <span class="etiqueta" style="color:var(--alerta)">humano</span>';
    html += "</td>";
    html += "<td>" + l.exchange_count + "</td>";
    html += "<td>" + dataCurta(l.updated_at) + "</td>";
    html += "</tr>";
  }
  alvo.innerHTML = html + "</tbody></table></div>";
}

async function verLead(id) {
  var corpo = $("detalhe-corpo");
  corpo.innerHTML = '<p class="vazio">Carregando...</p>';
  $("detalhe").showModal();

  var d;
  try {
    d = await api("/painel/leads/" + id);
  } catch (e) {
    if (e.message !== "401") corpo.innerHTML = '<p class="aviso">' + esc(e.message) + "</p>";
    return;
  }

  var l = d.lead;
  var html = '<h3 style="margin:0">' + esc(l.full_name || l.email) + "</h3>";
  html += '<div style="color:var(--fraco);font-size:13px">';
  html += esc(l.role_title || "cargo não identificado") + " &mdash; " + esc(l.email) + "</div>";
  html += '<div class="linha" style="margin:12px 0">';
  html += '<span class="etiqueta">' + esc(l.stage) + "</span>";
  html += '<span class="etiqueta">' + l.exchange_count + " troca(s)</span>";
  if (l.email_verified) html += '<span class="etiqueta" style="color:var(--ok)">e-mail verificado</span>';
  if (l.needs_human) html += '<span class="etiqueta" style="color:var(--alerta)">precisa de humano</span>';
  if (l.bounced_at) html += '<span class="etiqueta" style="color:var(--erro)">bounce</span>';
  if (l.resume_at) html += '<span class="etiqueta">retomar em ' + dataCurta(l.resume_at) + "</span>";
  html += "</div>";

  if (l.handoff_reason) html += '<p class="aviso">' + esc(l.handoff_reason) + "</p>";
  if (l.discard_reason) html += '<p class="vazio">Descartado: ' + esc(l.discard_reason) + "</p>";

  html += "<h2>Conversa</h2>";
  if (!d.conversa.length) {
    html += '<p class="vazio">Nenhuma mensagem trocada.</p>';
  } else {
    for (var i = 0; i < d.conversa.length; i++) {
      var m = d.conversa[i];
      var ehSaida = m.direction === "outbound";
      html += '<div class="msg ' + (ehSaida ? "saida" : "") + '">';
      html += '<div class="quem">' + (ehSaida ? "Nós" : "Lead") + " &mdash; " + dataCurta(m.created_at);
      if (m.shadow) html += " &mdash; sombra (não enviado)";
      if (m.intent) html += " &mdash; " + esc(m.intent);
      html += "</div>";
      if (m.subject) html += "<div><strong>" + esc(m.subject) + "</strong></div>";
      html += '<div class="corpo">' + esc(m.body) + "</div>";
      html += "</div>";
    }
  }

  html += "<h2>Eventos</h2>";
  if (!d.eventos.length) {
    html += '<p class="vazio">Nenhum evento registrado.</p>';
  } else {
    html += '<div class="rolagem"><table><thead><tr><th>Quando</th><th>O qu&ecirc;</th>';
    html += "<th>Detalhe</th></tr></thead><tbody>";
    for (var j = 0; j < d.eventos.length; j++) {
      var ev = d.eventos[j];
      html += "<tr><td>" + dataCurta(ev.created_at) + "</td>";
      html += "<td>" + esc(ev.kind) + "</td>";
      html += '<td><pre style="margin:0">';
      html += esc(ev.payload === null ? "—" : JSON.stringify(ev.payload));
      html += "</pre></td></tr>";
    }
    html += "</tbody></table></div>";
  }

  corpo.innerHTML = html;
}

async function criarCampanha() {
  var msg = $("criar-msg");
  var corpo = {
    name: $("f-name").value.trim(),
    solutionPurpose: $("f-proposito").value.trim(),
    schedulingLink: $("f-link").value.trim(),
    senderFirstName: $("f-sender").value.trim()
  };

  msg.className = "vazio";
  msg.textContent = "Criando...";
  try {
    await api("/campaigns", { method: "POST", body: corpo });
    msg.textContent = "Criada. Agora clique em Propor com IA no cartão dela.";
    $("f-name").value = "";
    $("f-proposito").value = "";
    $("f-link").value = "";
    $("f-sender").value = "";
    await carregar();
  } catch (e) {
    if (e.message !== "401") {
      msg.className = "aviso";
      msg.textContent = e.message;
    }
  }
}

// ---------------------------------------------------------------- proposta

// Qual campanha está aberta no editor. Guardado aqui porque os botões de
// salvar e aprovar vivem no diálogo, longe do cartão que foi clicado.
var propostaAberta = null;

function linhas(valor) {
  return String(valor || "")
    .split("\\n")
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });
}

/**
 * Pede a proposta à IA. Demora — é raciocínio alto no modelo — então o botão
 * desabilita e diz o que está acontecendo, senão a tela parece travada.
 */
async function propor(botao, id) {
  var saida = $("saida-" + id);
  botao.disabled = true;
  saida.innerHTML = "<pre>Pedindo a proposta &agrave; IA. Costuma levar algumas dezenas de segundos...</pre>";
  try {
    await api("/campaigns/" + id + "/propor", { method: "POST" });
    saida.innerHTML = "";
    await carregar();
    abrirProposta(id);
  } catch (e) {
    if (e.message !== "401") saida.innerHTML = '<pre class="aviso">' + esc(e.message) + "</pre>";
  } finally {
    botao.disabled = false;
  }
}

function abrirProposta(id) {
  var c = null;
  for (var i = 0; i < campanhasEmTela.length; i++) {
    if (campanhasEmTela[i].id === id) c = campanhasEmTela[i];
  }
  if (!c || !c.proposta) return;

  var p = c.proposta;
  var b = p.briefing || {};
  propostaAberta = id;

  $("p-nicho").value = p.nicho || "";
  $("p-oferta").value = p.oferta || "";
  $("p-cargos").value = (p.cargos || []).join("\\n");
  $("p-angulo").value = b.angulo || "";
  $("p-dores").value = (b.dores || []).join("\\n");
  $("p-provas").value = (b.provas || []).join("\\n");
  $("p-evitar").value = (b.evitar || []).join("\\n");
  $("p-assunto").value = (p.exemplo_de_email || {}).assunto || "";
  $("p-corpo").value = (p.exemplo_de_email || {}).corpo || "";

  $("p-msg").className = "vazio";
  $("p-msg").textContent = c.proposta_aprovada_em ? "Já aprovada. Salvar de novo exige aprovar de novo." : "";
  $("proposta").showModal();
}

function propostaDoFormulario() {
  return {
    nicho: $("p-nicho").value.trim(),
    oferta: $("p-oferta").value.trim(),
    cargos: linhas($("p-cargos").value),
    briefing: {
      angulo: $("p-angulo").value.trim(),
      dores: linhas($("p-dores").value),
      provas: linhas($("p-provas").value),
      evitar: linhas($("p-evitar").value)
    },
    exemplo_de_email: {
      assunto: $("p-assunto").value.trim(),
      corpo: $("p-corpo").value.trim()
    }
  };
}

async function salvarPropostaEditada() {
  if (!propostaAberta) return false;
  var msg = $("p-msg");
  msg.className = "vazio";
  msg.textContent = "Salvando...";
  try {
    await api("/campaigns/" + propostaAberta + "/proposta", {
      method: "PUT",
      body: propostaDoFormulario()
    });
    msg.textContent = "Rascunho salvo.";
    return true;
  } catch (e) {
    if (e.message !== "401") {
      msg.className = "aviso";
      msg.textContent = e.message;
    }
    return false;
  }
}

/**
 * Salva antes de aprovar, sempre.
 *
 * A aprovação promove o que está GRAVADO, não o que está na tela. Sem salvar
 * primeiro, uma edição feita e não salva seria silenciosamente descartada — a
 * pessoa aprovaria uma coisa e o funil usaria outra.
 */
async function aprovarPropostaEditada() {
  if (!propostaAberta) return;
  if (!(await salvarPropostaEditada())) return;

  var msg = $("p-msg");
  msg.textContent = "Aprovando...";
  try {
    await api("/campaigns/" + propostaAberta + "/aprovar-proposta", { method: "POST" });
    $("proposta").close();
    propostaAberta = null;
    await carregar();
  } catch (e) {
    if (e.message !== "401") {
      msg.className = "aviso";
      msg.textContent = e.message;
    }
  }
}

/**
 * O 401 do login e tratado aqui, e nao pela funcao api: la ele significa "sua
 * sessao acabou, entre de novo", e aqui significa "essa senha esta errada".
 * Mandar os dois pela mesma mensagem diria ao operador que a sessao expirou
 * no exato momento em que ele esta tentando criar uma.
 */
async function entrar() {
  var v = $("senha").value;
  if (!v) return;

  $("estado").hidden = false;
  $("estado").className = "vazio";
  $("estado").textContent = "Entrando...";

  var res;
  try {
    res = await fetch("/painel/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senha: v })
    });
  } catch (e) {
    return mostrarEntrada("N&atilde;o foi poss&iacute;vel falar com o servidor.");
  }

  $("senha").value = "";

  if (res.status === 401) return mostrarEntrada("Senha inv&aacute;lida.");
  if (res.status === 503) {
    return mostrarEntrada(
      "O painel n&atilde;o tem senha configurada. Defina PAINEL_SENHA no servi&ccedil;o."
    );
  }
  if (!res.ok) return mostrarEntrada("Falha no login (HTTP " + res.status + ").");

  carregar();
}

async function sair() {
  try { await fetch("/painel/sair", { method: "POST" }); } catch (e) { /* segue */ }
  mostrarEntrada();
}

$("entrar").onclick = entrar;
$("senha").onkeydown = function (e) { if (e.key === "Enter") entrar(); };
$("sair").onclick = sair;
$("recarregar").onclick = carregar;
$("criar").onclick = criarCampanha;
$("fechar-detalhe").onclick = function () { $("detalhe").close(); };
$("p-salvar").onclick = salvarPropostaEditada;
$("p-aprovar").onclick = aprovarPropostaEditada;
$("p-fechar").onclick = function () { $("proposta").close(); propostaAberta = null; };

// Delegacao: os cartoes sao redesenhados a cada recarga, e um ouvinte por
// botao morreria junto com o innerHTML anterior.
document.addEventListener("click", function (e) {
  if (!e.target.closest) return;
  var b = e.target.closest("button");
  if (b && b.dataset.acao) return dispararAcao(b, b.dataset.id, b.dataset.acao);
  if (b && b.dataset.propor) return propor(b, b.dataset.propor);
  if (b && b.dataset.proposta) return abrirProposta(b.dataset.proposta);
  if (b && b.dataset.empresas) return verEmpresas(b.dataset.empresas);
  if (b && b.dataset.eventos) return verEventos(b.dataset.eventos);
  if (b && b.dataset.leads) return verLeads(b.dataset.leads);
  var tr = e.target.closest("tr[data-lead]");
  if (tr) return verLead(tr.dataset.lead);
});

// Tenta carregar de cara: se o cookie da sessão anterior ainda vale, o
// operador entra direto. Se não, o 401 cai em mostrarEntrada e ele vê a
// tela de senha — sem precisar de nenhuma verificação prévia daqui.
carregar();
</script>
</body>
</html>`;
