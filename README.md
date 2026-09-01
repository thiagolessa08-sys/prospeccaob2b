# Prospecção B2B automatizada

Você escreve para que serve a solução que vende; a IA propõe o nicho, os
cargos e o discurso do e-mail; você refina numa tela; o sistema acha as
empresas, acha os decisores, escreve e envia o e-mail frio, conduz a conversa
e para quando a reunião está marcada.

## O funil

```
POST /campaigns                        cria a campanha a partir do propósito da solução
POST /campaigns/:id/propor             IA propõe nicho, cargos, discurso e e-mail de amostra
PUT  /campaigns/:id/proposta           grava o refino da pessoa (rascunho)
POST /campaigns/:id/aprovar-proposta   promove o rascunho a campanha e zera os filtros
POST /campaigns/:id/gerar-filtros      IA converte o nicho em CNAE / UF / cargo-alvo
GET  /campaigns/ativas                 o n8n descobre o que agendar
POST /campaigns/:id/descobrir-empresas Casa dos Dados → tabela companies
POST /campaigns/:id/enriquecer-lote    BrasilAPI + Hunter (ou Lusha) → decisor → lead
POST /campaigns/:id/enviar-lote        escreve e dispara o primeiro e-mail
POST /webhooks/instantly               resposta, bounce, descadastro (grava e sai)
POST /leads/:id/processar-resposta     classifica, decide e responde
POST /campaigns/:id/retomar-followups  reabre quem pediu "me procure depois"
POST /webhooks/calcom                  reunião marcada
```

As rotas de webhook respondem em segundos e **nunca** chamam IA — senão o
provedor considera a entrega falha e reentrega. Tudo que é lento roda nas
rotas de lote, que o n8n agenda.

O caminho antigo continua valendo: `POST /campaigns` com `nicheDescription` e
`offerDescription` escritos à mão cria a campanha direto, sem passar por
proposta. As campanhas criadas assim seguem funcionando.

## A proposta, e o que ela decide

A proposta é rascunho até ser aprovada: nada nela afeta o funil. Na aprovação,
`nicho` vira `niche_description` (que alimenta `gerar-filtros`), `oferta` vira
`offer_description` (que alimenta a voz dos e-mails) e o briefing vai para
`pitch_briefing`. O caminho novo termina no caminho antigo de propósito —
descoberta, enriquecimento e envio não precisaram saber que uma proposta
existe.

O briefing é **briefing, não modelo pronto**: o funil continua escrevendo um
e-mail por lead, com o nome da empresa e o cargo do decisor na mão, seguindo o
ângulo, as dores, as provas e o "não diga" que você aprovou. O e-mail de
amostra existe só para julgar o tom antes de aprovar — não é ele que sai.

Os cargos aprovados vencem os que a IA deriva do nicho em `gerar-filtros`. Sem
isso a tela de refino seria teatro: você editaria "Diretor Industrial" e o
funil sairia procurando o que o outro prompt achou melhor.

A aprovação zera `filters`, porque os filtros vigentes vieram do nicho
anterior. `gerar-filtros` precisa rodar de novo depois dela.

## Quem acha o decisor

Por padrão, a Hunter. Com `LUSHA_API_KEY` preenchida, a Lusha entra **no lugar
dela** — a cadeia leva uma chave só, e misturar as duas faria a credencial de
uma chegar no endpoint da outra.

A descoberta de empresas não muda: continua na Casa dos Dados, que vem da
Receita e traz CNPJ, CNAE e situação cadastral — dados que a Lusha não tem e
que o funil usa para recusar empresa inativa antes de gastar crédito.

Cada tentativa grava em `events` qual fornecedor a produziu, que é o que
permite comparar acerto e custo entre os dois.

⚠️ **O adaptador da Lusha não foi verificado contra a API ao vivo.** A
documentação dela é uma SPA e não entrega os schemas de requisição e resposta;
o código foi escrito a partir do que a documentação descreve em texto
(endpoints, header `api_key`, filtros, fluxo em duas etapas). A leitura da
resposta aceita mais de um nome plausível por campo e, quando não reconhece
nada, **lança** em vez de devolver lista vazia — para "campo renomeado" não se
disfarçar de "empresa sem decisor". O erro fica em `events`.

## Travas de segurança

- **Modo sombra** (`send_mode = shadow`, o padrão de toda campanha nova):
  grava em `messages` exatamente o que teria saído, sem chamar fornecedor
  nenhum. É o único jeito de ensaiar sem que um estranho receba e-mail.
- **Lista de supressão**: `assertSendable` é chamada na última milha de todo
  provedor de envio, não só no laço do lote. Descadastro e bounce definitivo
  suprimem o endereço para todas as campanhas do tenant.
- **Disjuntor de bounce**: acima de 3% (com amostra mínima de 20 envios) a
  campanha é pausada sozinha.
- **Repasse a humano**: classificação com confiança baixa, conversa longa sem
  desfecho, ou qualquer falha no meio do processamento marcam `needs_human` em
  vez de improvisar uma resposta.

## Painel do operador

Em `/painel`. Serve para criar campanha, disparar as rotas de lote à mão e
acompanhar o que aconteceu — empresas descobertas, leads por estágio, a
conversa de cada lead e a trilha de eventos.

Entra com `PAINEL_SENHA` e recebe um cookie de sessão assinado (`HttpOnly`,
`Secure`, `SameSite=Strict`, 12 h). A sessão não vive no servidor: a validade
viaja dentro do cookie e a assinatura a torna inviolável, então um deploy do
Railway não derruba ninguém. Para revogar todas as sessões de uma vez, troque
`PAINEL_SENHA` — ela é a chave que assina.

A senha é do operador; o `N8N_SHARED_SECRET` segue sendo só do n8n. Quem
apresenta um cookie válido é tratado como o n8n na borda (`comoOperador`, em
`src/api/server.ts`), o que deixa os handlers sem saber que o painel existe —
a checagem de segredo continua dentro de cada um, e continua testável por
invocação direta.

Sem `PAINEL_SENHA` no ambiente o login devolve 503 e o resto da API segue
funcionando. É de propósito: torná-la obrigatória faria um deploy já existente
parar de subir no instante em que este código chegasse ao servidor.

## Rodar local

```bash
npm install
npm test          # 456 testes, Postgres em memória (PGlite) — não precisa de banco
npm run smoke:funil
```

O smoke roda o funil inteiro de ponta a ponta, em modo sombra, contra Postgres
em memória. Funciona **sem nenhuma chave de API**: cada etapa usa a API real se
a chave existir no ambiente e um stub rotulado se não existir. Ele é
incapaz de enviar e-mail — força modo sombra e aborta se a campanha não estiver
assim.

## Subir

```bash
npm run build                          # TypeScript → dist/
DATABASE_URL=... npm run db:migrate    # aplica o schema num Postgres vazio
npm start                              # node dist/api/main.js
```

No Railway a migration roda sozinha antes do servidor (`railway.json` →
`startCommand`), usando a `DATABASE_URL` que já está no ambiente — não é
preciso passar credencial de banco à mão. Ela sai limpa quando o schema já
existe.

### Migrations

Os `.sql` ficam em `supabase/migrations/`, nomeados `NNNN_descricao.sql` com
quatro dígitos — a ordem de aplicação é a ordem alfabética, e sem largura fixa
`10_x` viria antes de `9_x`. Nome fora da convenção derruba o migrador em vez
de ser ignorado: migration pulada em silêncio vira schema incompleto que só
falha muito depois.

O que já rodou é controlado por `schema_migrations`. Cada migration roda em
sua própria transação, então a que falha desfaz só a si mesma e as anteriores
continuam registradas — reexecutar depois do conserto retoma de onde parou.

Um banco criado pelo migrador antigo (que aplicava só o `0001` e não
registrava nada) é adotado na primeira execução: o `0001` entra em
`schema_migrations` sem ser reaplicado. Sem isso o deploy morreria em
`type "lead_stage" already exists`.

Variáveis de ambiente: veja `.env.example`. Quase todas são exigidas no boot —
o processo morre nomeando as que faltam, em vez de subir pela metade e falhar
na primeira chamada de rota. As exceções são deliberadas:
`INSTANTLY_PREMISSA_VALIDADA_EM` (vazia trava o envio pelo Instantly),
`PAINEL_SENHA` (vazia desliga só o painel) e `LUSHA_API_KEY` (vazia mantém a
Hunter).

## Estado

O funil tem código do início ao fim e 456 testes passando, mas **ainda não
rodou contra as APIs pagas de verdade**. Dois pontos estão marcados no código
como suposições não confirmadas contra conta real:

- o mapeamento cargo → departamento da Hunter (`src/enrichment/alvo.ts`);
- o padrão de `custom_variables` do Instantly, que a documentação dele não
  descreve — protegido por um gate que recusa construir o provedor sem uma
  validação registrada (`INSTANTLY_PREMISSA_VALIDADA_EM`).
