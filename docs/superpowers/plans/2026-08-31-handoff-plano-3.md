# Handoff do Plano 2 para o Plano 3

O Plano 2 (persistência e enriquecimento) está completo, revisado e aprovado
para merge. 208 testes, `tsc --noEmit` limpo.

**Plano 2:** [2026-08-31-persistencia-e-enriquecimento.md](2026-08-31-persistencia-e-enriquecimento.md)
**Handoff anterior:** [2026-08-31-handoff-plano-2.md](2026-08-31-handoff-plano-2.md)
**Spec (6 emendas):** [2026-08-28-prospeccao-b2b-ia-design.md](../specs/2026-08-28-prospeccao-b2b-ia-design.md)

## O que o Plano 3 é

Envio e conversa: adaptador do Instantly, webhook do Cal.com, as rotas HTTP que
recebem os webhooks, e o disjuntor de bounce. É o plano que faz o sistema
efetivamente mandar um e-mail.

A descoberta de empresas por filtro (Casa dos Dados) também está pendente — o
provedor já foi escolhido e o contrato verificado; veja a seção "Provedor de
descoberta" no fim do Plano 2. Decida se ela entra no Plano 3 ou vira um plano
próprio.

## O que o Plano 2 deixou pronto

| Camada | Módulos |
|---|---|
| Porta SQL | `src/db/port.ts`, `src/db/postgres.ts` (`pg.Pool`) |
| Repositórios | campanhas, empresas, leads, mensagens, supressão, eventos |
| HTTP | `src/http/fetch-json.ts` — timeout, retry seletivo, segredos mascarados |
| Enriquecimento | BrasilAPI (grátis), Hunter.io (pago), cadeia, `paraNovoLead` |

Os testes de banco rodam contra Postgres 18 real via PGlite, sem Docker.

## Obrigações que o Plano 3 herda

1. **Chame `assertSendable(email, regras)` antes de todo envio.** Ela existe
   desde o Plano 1 exatamente para isso e **ainda não tem nenhum chamador** —
   o caminho de envio é o Plano 3. Carregue as regras com
   `carregarRegrasDeSupressao(db, tenantId)`.

2. **Persista `tentativas` em `events`.** `enriquecerDecisor` devolve o que
   cada fonte respondeu, e `registrarEvento` está pronto — mas nada liga os
   dois ainda. Sem essa ligação, a taxa de acerto real no Brasil continua
   desconhecida, que é o único motivo de `tentativas` existir.

3. **Use `paraNovoLead` para virar candidato em lead.** Ele já resolve a
   decisão de produto que não é óbvia: `accept_all` **não** conta como
   verificado. A cadeia aceita `accept_all` como candidato, mas ele não entra
   na fila de envio, que `listarProntosParaContato` filtra por
   `email_verified = true`. Não reimplemente essa conversão à mão.

4. **Carregue `leads.needs_human` junto da classificação.** `decideNextAction`
   exige `needsHuman` como campo obrigatório. Depois que uma conversa vai para
   um humano, a IA precisa parar de responder àquele lead.

5. **`messages.confidence` volta como `string`, não `number`.** O tipo
   `numeric` não é convertido por nenhum dos dois drivers, de propósito
   (precisão de ponto flutuante). Ao reconstituir uma `ReplyClassification` a
   partir da linha, converta com `Number()` — e note que
   `decideNextAction` já trata valor não-finito como confiança baixa, então um
   `Number(null)` degrada com segurança para repasse a humano.

6. **Use `messages.external_id` como chave de idempotência do webhook.** O
   índice único parcial já existe e `anexarMensagem` devolve `null` na
   reentrega. Trate `null` como "já processei" e responda 2xx ao Instantly.

## Coisas que a revisão descobriu e você não vai adivinhar sozinho

**A BrasilAPI recusa o user-agent padrão do Node.** Sem um UA explícito a
requisição não passa (403 ou 429, conforme a borda). `fetch-json.ts` já manda
`user-agent: prospeccao/0.1` em toda requisição. **Não remova.** Isso só
apareceu porque existe um teste de contrato ao vivo — a suíte mockada inteira
ficava verde enquanto toda consulta de CNPJ falharia em produção.

**Repita o padrão do teste ao vivo para o Cal.com.** Um teste
`describe.skipIf(!process.env.LIVE_API)` contra uma API grátis custa nada e
cobre a suposição de contrato mais cara do módulo. Rode com `LIVE_API=1 npm test`.
**Não faça isso com a Hunter** — cada chamada gasta crédito.

**PGlite serializa conexões; `pg.Pool` não.** Toda leitura-seguida-de-escrita é
serializada por construção no teste e concorrente em produção. Nenhum teste
falha por corrida. `transicionarLead` já usa compare-and-swap por causa disso;
qualquer novo par leitura-escrita precisa da mesma proteção.

**Onde a interseção do porte vaza:** `numeric` volta como string nos dois
drivers, e `int8`/`count(*)` volta `number` no PGlite e `string` no node-pg. O
próximo recurso óbvio — impor `campaigns.daily_send_limit` — precisa de
`count(*)` e passaria no teste quebrando em produção. Está documentado em
`src/db/port.ts`.

## Riscos abertos

1. **A migration ainda nunca rodou num Supabase real.** Ela roda a cada
   `npm test` contra Postgres 18 em WASM, o que é muito mais do que antes, mas
   o primeiro `apply` de verdade continua sendo um marco a observar.
2. **Nenhuma chamada real à Claude API foi feita** — herdado do Plano 1.
   `npm run smoke:niche` continua pendente de uma `ANTHROPIC_API_KEY`.
3. **A cobertura da Hunter no Brasil segue desconhecida.** É o que a obrigação
   nº 2 acima existe para medir.
4. **`paraNovoLead` não tem chamador de produção.** A integração com
   `criarLead` está provada só em teste unitário.

## Dívidas técnicas aceitas

- **Escrita entre tenants**: as guardas de existência resolvem o caso prático,
  mas a proteção durável é `unique (tenant_id, id)` nas tabelas pai com FKs
  compostas nas filhas. Vale numa migration futura.
- **`criarLead` com e-mail duplicado** levanta o erro cru do driver, em inglês,
  com nome de constraint — enquanto todo o resto do branch lança mensagem de
  domínio em português. O índice é por tenant, não por campanha, então a mesma
  pessoa alvo de duas campanhas cai nesse caminho. Cenário rotineiro.
- **A busca por domínio da Hunter só tenta o candidato de maior confiança.** Se
  ele reprovar na verificação, os outros da mesma resposta paga são
  descartados. O laço de sócios itera todos. Reavaliar quando houver dados de
  taxa de acerto.
- **Supressão é sensível a maiúsculas na tabela**, embora `isSuppressed`
  compare normalizado. Acumula variantes da mesma regra.
- `getDb` memoiza o pool e ignora uma connection string diferente; não há
  `pool.end()`.
- `USER_AGENT` fixa `0.1` enquanto o `package.json` diz `0.1.0`.
- Erro de rede (DNS, connection reset) não é repetido — só status HTTP. Pesa
  mais na BrasilAPI, que é comunitária e sem SLA.
