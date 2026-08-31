# Handoff do Plano 1 para o Plano 2

O Plano 1 (núcleo: schema, domínio e IA) está completo, revisado e aprovado
para merge. Este documento é o que o Plano 2 precisa saber e não consegue
descobrir lendo o código.

**Plano 1:** [2026-08-31-nucleo-dominio-ia.md](2026-08-31-nucleo-dominio-ia.md)
**Spec (com 6 emendas):** [2026-08-28-prospeccao-b2b-ia-design.md](../specs/2026-08-28-prospeccao-b2b-ia-design.md)

## O que existe agora

90 testes, `tsc --noEmit` limpo. Módulos puros e testáveis, sem nenhuma
integração externa e sem caminho de envio.

| Módulo | Responsabilidade |
|---|---|
| `src/config/env.ts` | Acesso validado ao ambiente (`env()` é função, não constante) |
| `src/db/types.ts` | Tipos de domínio e as duas constantes de enum |
| `src/db/client.ts` | Cliente Supabase com service role key |
| `src/domain/stages.ts` | Transições válidas do funil |
| `src/domain/suppression.ts` | Quem pode receber e-mail (`assertSendable` é a trava) |
| `src/domain/reply-policy.ts` | Núcleo de segurança: decide a próxima ação |
| `src/ai/niche-parser.ts` | Nicho em texto livre → filtros estruturados |
| `src/ai/email-writer.ts` | E-mail de primeiro contato |
| `src/ai/reply-classifier.ts` | Classifica a resposta em seis intenções |
| `src/ai/reply-writer.ts` | Redige a réplica conforme a ação decidida |

## Obrigações que o Plano 2 herda

Estas não são sugestões — o Plano 1 depende delas para funcionar como
projetado.

1. **Carregue `leads.needs_human` junto da classificação.** `decideNextAction`
   recebe `needsHuman` como campo **obrigatório**, de propósito. Depois que uma
   conversa vai para um humano, a IA precisa parar de responder àquele lead.
   Torná-lo opcional-com-default reintroduz silenciosamente o bug.

2. **Chame `assertSendable(email, rules)` antes de qualquer envio.** Ela existe
   exatamente para que o caminho de envio não possa esquecer da lista de
   supressão. O Plano 1 não a chama de lugar nenhum porque ainda não há envio.

3. **Colete `sender_first_name` na criação da campanha.** É `NOT NULL` sem
   default. Sem ele, o modelo voltaria a inventar o nome de quem assina.

4. **Avance o estágio depois de classificar, não antes.** Uma resposta
   `out_of_scope` (auto-resposta de férias) deve devolver o lead a `contacted`.
   `in_conversation → contacted` é a única transição para trás do funil, aberta
   exatamente para isso.

5. **Use `messages.external_id` como chave de idempotência.** O índice único
   parcial já existe. Webhook do Instantly repete entrega; sem isso o lead
   recebe a mesma resposta duas vezes.

## Riscos abertos, em ordem de importância

1. **Nenhuma linha do SQL jamais rodou.** RLS, o trigger de `updated_at` e os
   dois índices únicos parciais são código não executado. Valide tudo no
   primeiro apply real, antes de existir qualquer dado.

2. **Nenhuma chamada à Claude API jamais foi feita.** Todos os testes de IA
   mockam o cliente. A combinação `zodOutputFormat` + `messages.parse` +
   `output_config` está validada por tipo e por leitura, não por execução —
   e esse eixo já falhou duas vezes nesta base (pin do SDK sem `helpers/zod`;
   zod 3 passando no typecheck e quebrando em runtime). Rode
   `npm run smoke:niche` assim que houver `ANTHROPIC_API_KEY`, **antes** de
   replicar o padrão em novos módulos.

3. **O painel precisará de policies RLS por tenant.** Hoje o banco é
   deny-by-default e só a service role key passa. A chave anônima do Supabase
   é pública por natureza — sem policies, o painel não consegue ler nada
   (correto), mas escrever policies frouxas exporia todos os tenants.

## Dívidas técnicas aceitas

- **Extrair `callStructured()` antes do 5º módulo de IA.** Os quatro módulos
  repetem o envelope "system cacheado → `messages.parse` → erro se
  `parsed_output` for nulo". O argumento para extrair não é DRY, é fazer as
  Global Constraints (modelo, `cache_control`, formato) valerem em um lugar só
  em vez de serem redigitadas a cada chamada. O helper deve absorver só o
  envelope — nunca o conteúdo dos prompts, nem `effort`, nem as guardas de
  domínio. Mantenha-o genérico no schema Zod, ou a inferência de
  `parsed_output` se perde.
- **`src/ai/contracts.ts`** como casa de `EmailDraft`/`CampaignVoice`, hoje
  importados de `email-writer.ts` por módulos que não têm nada a ver com o
  primeiro contato.
- **`z.string().url()` → `z.url()`** em `src/config/env.ts` (a primeira forma
  está deprecada no Zod 4).
- **`reason` em `NextAction`** é string livre. Se algo passar a ramificar por
  ele (filtro do painel, nó de switch no n8n), converta antes para union de
  literais.
- **Vitest → v4** resolve 5 vulnerabilidades transitivas, todas de
  desenvolvimento (`vitest → vite → esbuild`), sem superfície em produção.
