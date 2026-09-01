# Prospecção B2B automatizada

Você descreve o nicho em texto livre; o sistema acha as empresas, acha os
decisores, escreve e envia o e-mail frio, conduz a conversa e para quando a
reunião está marcada.

## O funil

```
POST /campaigns                        cria a campanha a partir do nicho em texto
POST /campaigns/:id/gerar-filtros      IA converte o texto em CNAE / UF / cargo-alvo
GET  /campaigns/ativas                 o n8n descobre o que agendar
POST /campaigns/:id/descobrir-empresas Casa dos Dados → tabela companies
POST /campaigns/:id/enriquecer-lote    BrasilAPI + Hunter → decisor → lead
POST /campaigns/:id/enviar-lote        escreve e dispara o primeiro e-mail
POST /webhooks/instantly               resposta, bounce, descadastro (grava e sai)
POST /leads/:id/processar-resposta     classifica, decide e responde
POST /campaigns/:id/retomar-followups  reabre quem pediu "me procure depois"
POST /webhooks/calcom                  reunião marcada
```

As rotas de webhook respondem em segundos e **nunca** chamam IA — senão o
provedor considera a entrega falha e reentrega. Tudo que é lento roda nas
rotas de lote, que o n8n agenda.

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

Variáveis de ambiente: veja `.env.example`. Todas são exigidas no boot — o
processo morre nomeando as que faltam, em vez de subir pela metade e falhar na
primeira chamada de rota.

## Estado

O funil tem código do início ao fim e 456 testes passando, mas **ainda não
rodou contra as APIs pagas de verdade**. Dois pontos estão marcados no código
como suposições não confirmadas contra conta real:

- o mapeamento cargo → departamento da Hunter (`src/enrichment/alvo.ts`);
- o padrão de `custom_variables` do Instantly, que a documentação dele não
  descreve — protegido por um gate que recusa construir o provedor sem uma
  validação registrada (`INSTANTLY_PREMISSA_VALIDADA_EM`).
