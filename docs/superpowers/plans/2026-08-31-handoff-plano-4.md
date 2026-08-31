# Handoff do Plano 3 para o Plano 4

O Plano 3 (envio) está completo, revisado e mesclado. 291 testes, 2 pulados
(contratos ao vivo), `tsc --noEmit` limpo.

**Plano 3:** [2026-08-31-envio.md](2026-08-31-envio.md)
**Handoffs anteriores:** [Plano 2](2026-08-31-handoff-plano-2.md) · [Plano 3](2026-08-31-handoff-plano-3.md)
**Spec (6 emendas):** [2026-08-28-prospeccao-b2b-ia-design.md](../specs/2026-08-28-prospeccao-b2b-ia-design.md)

## O que o Plano 4 é

Conversa e camada HTTP: os webhooks do Instantly e do Cal.com, a orquestração
`processarResposta()`, e o servidor que expõe as rotas. É o plano que fecha o
laço — depois dele o sistema conversa sozinho até marcar a reunião.

As decisões de arquitetura já estão tomadas e verificadas nesta máquina; veja
"Decisões que o Plano 4 herda prontas" abaixo.

## O que o Plano 3 deixou pronto

| Módulo | Responsabilidade |
|---|---|
| `src/domain/bounce.ts` | Disjuntor: função pura sobre contagens, com piso de amostra |
| `src/sending/types.ts` | `ColdEmailProvider`, com `modo` para casar com o da campanha |
| `src/sending/shadow.ts` | Grava o que teria enviado; não chama ninguém |
| `src/sending/instantly.ts` | Adaptador do Instantly v2 |
| `src/sending/enviar-lote.ts` | Disparo diário: guardas, supressão, teto, disjuntor |

## Obrigações que o Plano 4 herda

1. **Escreva `leads.bounced_at` a partir do webhook `email_bounced` do
   Instantly.** Sem isso o disjuntor de bounce **não consegue abrir** — ele lê
   essa coluna e hoje nada a escreve. O `enviarLote` já grava um evento
   `disjuntor_sem_fonte_de_bounce` quando uma amostra significativa não tem
   nenhum bounce, justamente para essa inércia não passar despercebida. Fechar
   esse laço é a obrigação nº 1 deste plano.

2. **Selecione o provedor a partir de `campaigns.send_mode`.** O `enviarLote`
   recusa um provedor cujo `modo` diverge do da campanha, mas quem constrói o
   provedor é o chamador — e é o Plano 4 que passa a construir. O padrão do
   schema é `'shadow'`, então a fiação falha para o lado seguro; não a inverta.

3. **Passe `premissaValidadaEm` ao construir o provedor do Instantly.** Ele
   lança sem isso, de propósito (ver o risco aberto nº 1 abaixo).

4. **O webhook não pode fazer o trabalho pesado.** Classificar, decidir,
   redigir e enviar são duas ou três chamadas ao Claude — dezenas de segundos.
   Um webhook lento estoura o limite de plataforma serverless e faz o remetente
   reentregar. Separe: o webhook verifica, grava a mensagem recebida e responde
   2xx; a rota lenta de processamento é chamada pelo n8n.

5. **Trate `anexarMensagem` devolvendo `null` como "já processei"** e responda
   2xx ao Instantly. É a idempotência do webhook, e o índice único parcial já
   está no lugar.

6. **Carregue `leads.needs_human` junto da classificação.** `decideNextAction`
   exige `needsHuman` como campo obrigatório.

7. **`messages.confidence` volta como `string`.** Converta com `Number()` — e
   note que `decideNextAction` já trata valor não-finito como confiança baixa,
   então um `Number(null)` degrada com segurança para repasse a humano.

## Decisões que o Plano 4 herda prontas

Verificadas nesta máquina; não refaça a investigação.

**Handlers web-standard.** Um `(req: Request) => Promise<Response>` é testável
por invocação direta — construir um `Request`, chamar a função, ler o
`Response`. Sem servidor, sem porta, sem supertest. Node 24 tem os dois globais.
E como é exatamente a assinatura que um route handler do Next.js App Router
espera, o painel do Plano 5 pode reexportar as mesmas funções sem adaptador.
Hono 4.13.5 (~14 KB) serve para amarrar as rotas.

**Duas armadilhas de assinatura, verificadas:**

- `timingSafeEqual` **lança** quando os tamanhos diferem, em vez de devolver
  `false`. Uma assinatura curta ou ausente derrubaria o handler com 500 — e um
  500 faz o remetente reentregar para sempre. A guarda de tamanho vem antes,
  obrigatoriamente.
- O corpo de um `Request` **só pode ser lido uma vez**. Depois de
  `await req.text()`, chamar `req.json()` lança `TypeError`. Como a assinatura
  é calculada sobre o corpo cru (reserializar muda espaços e ordem de chaves),
  o handler precisa ler o texto uma vez, verificar, e então `JSON.parse`. Um
  handler escrito na ordem natural — `req.json()` primeiro — não tem como
  funcionar.

**Cal.com — contrato verificado.** Envelope `{ triggerEvent, createdAt, payload }`.
Campos: `payload.attendees[0].email` e `.name`, `payload.startTime`,
`payload.uid`, `payload.type`. Assinatura no header **`X-Cal-Signature-256`**,
HMAC-SHA256 sobre o corpo cru, sem timestamp. O segredo é opcional no Cal.com e
deixá-lo em branco torna o header inútil — **sempre defina um**.

**Casar agendamento com lead: pelo e-mail do participante.** O caminho do
identificador oculto (pergunta customizada) **não pôde ser verificado** — o lado
do prefill está documentado, o lado do webhook não. `leads` tem índice único em
`(tenant_id, lower(email))`, então a busca é exata. **O prospect pode editar o
e-mail preenchido**; quando nenhum lead casar, grave um evento com o payload
inteiro e responda 2xx. Uma reunião marcada que o sistema não registra é pior do
que um erro visível.

**Instantly — NÃO assina os webhooks.** Confirmado ausente da documentação: sem
HMAC, sem header de assinatura. O único mecanismo é o campo `headers` do
registro, ou seja, um segredo compartilhado que nós definimos e conferimos.
São dois mecanismos diferentes; **não escreva um verificador só**. E segredo em
header só é seguro sobre TLS — a rota tem que ser HTTPS, e isso é requisito de
implantação, não recomendação.

**Payload de `reply_received`:** `timestamp`, `event_type`, `campaign_id`,
`lead_email`, `email_account`, `email_id` (uuid da resposta, use como chave de
idempotência), `reply_subject`, `reply_text`, `reply_html`, `is_first`, `step`.

**Não dá para cancelar follow-up de um lead pela API.** O Instantly para
sozinho ao detectar resposta, e a documentação dele lista modos de falha dessa
detecção (resposta de outro endereço, encaminhamento que apaga o original).
Nosso webhook é a rede de segurança, não o mecanismo primário.

**Hospedagem precisa ser decidida, não herdada.** As rotas lentas inviabilizam
Vercel Hobby (10 s). Uma VPS pequena, Railway, Render ou Fly resolvem por ~US$ 5
/mês e é onde o Hono roda sem cerimônia; Vercel Pro (`maxDuration` até 300 s)
serve se o painel for para lá. O padrão silencioso é o único que quebra.

## Riscos abertos

1. **A premissa central do Instantly nunca foi validada.** O produto inteiro
   depende de entregar assunto e corpo únicos por lead via `custom_variables`
   num template feito só de merge tags. Esse padrão aparece no material de
   personalização com IA do próprio Instantly, mas **não na referência da API**,
   e não há conta neste ambiente para testar. `criarProvedorInstantly` **lança**
   sem `premissaValidadaEm` justamente para que ninguém esqueça. Existe
   `tests/sending/instantly.live.test.ts` pronto, atrás de `LIVE_API=1`.
   Se falhar, o Instantly é a ferramenta errada e a escolha do spec precisa ser
   revista — por isso `ColdEmailProvider` existe.
2. **Nenhuma chamada real à Claude API foi feita** — herdado do Plano 1.
   `npm run smoke:niche` continua pendente de uma `ANTHROPIC_API_KEY`.
3. **A migration nunca rodou num Supabase real.** Roda a cada `npm test` contra
   Postgres 18 em WASM, mas o primeiro `apply` de verdade segue sendo um marco.
4. **A cobertura da Hunter no Brasil segue desconhecida** — a instrumentação
   para medi-la existe (`tentativas`), mas nada a persiste ainda.

## Dívidas técnicas aceitas

- **Um único `INSTANTLY_CAMPAIGN_ID` global.** Todos os tenants e campanhas
  compartilham uma campanha no Instantly. É por isso que o disjuntor prefere a
  contagem local: os números do fornecedor seriam do workspace inteiro, e a
  lista ruim de um cliente pausaria a campanha de outro. O conserto real é uma
  coluna de id por campanha. **Não "conserte" a preferência de volta** sem
  fazer isso antes.
- **`date_trunc('day', now())` usa o fuso do servidor.** Num banco em UTC, o
  teto "diário" zera às 21h de Brasília — no meio da noite de trabalho de quem
  envia. Considerar `America/Sao_Paulo` explícito.
- **O evento de aviso do disjuntor grava a cada lote** enquanto não houver
  fonte de bounce — o mesmo padrão de ruído que `pausarCampanha` evita com uma
  guarda. Resolve-se sozinho quando a obrigação nº 1 for cumprida.
- **`toFixed(1)` sobrou no ramo "dentro do limite"** de `avaliarDisjuntor`: 2,999%
  renderiza "3.0%, dentro do limite", a imagem espelhada da contradição que já
  foi corrigida no outro ramo.
- **Duplicata ou falha de gravação subconta o teto diário**, permitindo que uma
  reexecução no mesmo dia exceda o limite por essa margem.
- **Supressão é carregada por lead nos adaptadores**, um round trip a mais por
  destinatário. Correto de propósito (um descadastro precisa valer no meio do
  lote), mas vale cache se os lotes passarem de 50.
- **Ensaio em sombra repetido regenera rascunhos** para os mesmos N primeiros
  leads e nunca ensaia além do teto.
