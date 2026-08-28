# Design — Plataforma de Prospecção B2B Automatizada com IA

**Data:** 2026-08-28
**Status:** Aprovado pelo usuário (arquitetura, fluxos e plano de rollout validados em conversa)
**Autor:** Thiago Lessa + Claude

## 1. Objetivo

O usuário descreve um nicho/perfil de empresas em texto livre (ex.: "indústrias de
alimentos em SC com 50+ funcionários, falar com gerente de TI") e o sistema, de forma
autônoma: encontra as empresas, identifica o decisor da área, envia e-mails
personalizados, conduz a conversa (respostas, dúvidas, objeções) e leva o lead até o
agendamento de uma reunião via link de agenda.

## 2. Decisões de escopo (respostas do usuário)

| Decisão | Escolha |
|---|---|
| Fonte de dados | Híbrido: fontes gratuitas (CNPJ/Casa dos Dados, Google Maps, site da empresa) + API paga pontual só para e-mail do decisor — padrão: **Hunter.io** (Snov.io como alternativa se o piloto mostrar cobertura melhor no Brasil) |
| Condução da conversa | IA responde sozinha até marcar a reunião (com travas de segurança) |
| Infra de envio | Ferramenta de cold e-mail (Instantly.ai) com domínio paralelo dedicado e warm-up |
| Orquestração | n8n (cloud) |
| Agendamento | Link de agendamento (Cal.com) conectado à agenda do usuário |
| Interface | Painel web próprio (Next.js) |
| Propósito | Uso interno agora, desenhado para virar produto multi-cliente depois |
| Mercado/volume | Brasil, 20–50 novos contatos/dia por caixa, crescendo gradualmente |

## 3. Arquitetura

Cinco componentes, cada um com uma responsabilidade única:

```
Painel Web (Next.js/Vercel) ──▶ Supabase (Postgres) ◀── n8n (fluxos)
                                                          │
                        ┌─────────────────┬───────────────┼──────────────┐
                        ▼                 ▼               ▼              ▼
                  Casa dos Dados     Hunter/Snov      Claude API     Instantly
                  + Google Maps      (e-mail do       (personaliza   (envio, warm-up,
                  (empresas)         decisor)         e responde)    webhooks)
                                                                        │
                                                                     Cal.com
```

### 3.1 Painel Web (Next.js + Supabase Auth, deploy na Vercel)
- Criar campanha: campo de texto livre para o nicho + configuração da oferta
  (o que a empresa vende, tom de voz, teto diário de envio).
- Funil kanban: Descoberto → Enriquecido → Contatado → Em conversa →
  Reunião marcada / Descartado.
- Detalhe do lead: dados da empresa/decisor, conversa completa, raciocínio da IA em
  cada resposta, botão pausar/retomar lead e campanha.
- Métricas: enviados, entregues, abertos, respostas, reuniões, taxa de bounce.
- Só lê/escreve o Supabase; nenhuma lógica de prospecção vive no painel.

### 3.2 Supabase (Postgres) — fonte de verdade
Tabelas principais (todas com `tenant_id` desde o dia 1):
- `campaigns` — nicho em texto livre, filtros estruturados gerados pela IA, oferta,
  tom, teto diário, status (ativa/pausada).
- `companies` — CNPJ, razão social, site, resumo gerado pela IA, origem, estágio.
- `leads` — decisor: nome, cargo, e-mail, status de verificação, estágio no funil,
  motivo de descarte quando houver.
- `messages` — toda troca de e-mail (enviados e recebidos), classificação da IA,
  raciocínio da IA, timestamps.
- `events` — auditoria: execuções de fluxo, erros, mudanças de estágio.
- `suppression_list` — opt-outs e domínios proibidos; global, nunca recontatados.

### 3.3 n8n (cloud) — quatro fluxos
Detalhados na seção 4.

### 3.4 Instantly.ai
- Caixas em domínio paralelo dedicado (ex.: sqltech.net.br) — protege a reputação
  do domínio principal.
- Warm-up automático, envio em ritmo seguro, sequências de follow-up, webhook de
  resposta para o n8n.

### 3.5 Claude API
Dois papéis:
1. **Estruturação**: converte a descrição do nicho em filtros de busca (CNAE, porte,
   UF, cargo-alvo).
2. **Redação**: escreve o primeiro e-mail e cada resposta, com prompt de sistema que
   conhece a oferta, o tom e as regras (nunca prometer preço, propor o link Cal.com
   quando houver interesse, descartar com educação em caso de "não").

### 3.6 Custo mensal estimado
Instantly ~US$ 37 + n8n cloud ~US$ 20 + Hunter/Snov ~US$ 30–50 + Claude API
~US$ 10–30 + Supabase/Vercel grátis ≈ **US$ 100–140/mês**.

## 4. Fluxos do n8n

### Fluxo 1 — Descoberta (dispara na criação de campanha, via webhook do painel)
1. Claude converte o nicho em filtros estruturados (CNAE, porte, UF, cargo-alvo);
   filtros são gravados na campanha e visíveis no painel.
2. Busca empresas na Casa dos Dados (CNPJ); complementa com Google Maps quando o
   nicho for local.
3. Visita o site de cada empresa e Claude extrai um resumo ("o que essa empresa
   faz") — insumo da personalização.
4. Grava em `companies` com estágio **Descoberto**. CNPJ já existente em qualquer
   campanha é pulado (dedup global).

### Fluxo 2 — Enriquecimento (agendado, a cada hora, sobre estágio Descoberto)
1. Busca o decisor do cargo-alvo: primeiro fontes grátis (site, quadro societário do
   CNPJ); Hunter/Snov apenas se as fontes grátis falharem.
2. Verifica o e-mail (validação Hunter/Snov). E-mail inválido não entra na fila.
3. Sucesso → `leads` com estágio **Enriquecido**. Sem decisor encontrável →
   **Descartado** com motivo registrado.

### Fluxo 3 — Primeiro contato (diário, respeita o teto da campanha)
1. Seleciona leads Enriquecidos até o teto diário (20–50, configurável).
2. Claude escreve e-mail personalizado usando resumo do site, cargo e nicho.
3. Sobe lead + e-mail no Instantly com sequência de 2 follow-ups (dia +3 e +7),
   também redigidos pela IA, cancelados automaticamente se houver resposta.
4. Estágio → **Contatado**. Sequência esgotada sem resposta → **Descartado (sem
   resposta)**, reciclável no futuro.

### Fluxo 4 — Conversa (webhook do Instantly a cada resposta recebida)
1. Grava a resposta em `messages`; cancela follow-ups pendentes; estágio →
   **Em conversa**.
2. Claude classifica: interessado / dúvida ou objeção / não agora / não / opt-out /
   fora do escopo (ex.: auto-resposta de férias).
3. Ação por classificação:
   - **Interessado** → envia link Cal.com direto.
   - **Dúvida/objeção** → responde e conduz ao link.
   - **Não agora** → agradece e agenda retomada futura (data em `leads`).
   - **Não / opt-out** → agradece, **Descartado**, entra na `suppression_list`.
   - **Fora do escopo** → aguarda/reprograma conforme o caso.
4. Webhook do Cal.com em agendamento → estágio **Reunião marcada** + notificação
   ao usuário por e-mail.

**Travas de segurança do Fluxo 4:**
- Classificação com confiança baixa OU conversa com mais de 5 trocas sem desfecho →
  IA para e notifica o usuário para assumir.
- Toda resposta enviada é logada em `messages` com o raciocínio da IA (auditável
  no painel).

## 5. Tratamento de erros

- Error workflow global no n8n: qualquer falha grava em `events`, marca o lead com
  estágio de erro (nada some silenciosamente) e notifica o usuário em caso de
  reincidência.
- APIs externas com retry e respeito a rate limit; fonte fora do ar → lead permanece
  na fila e é reprocessado na próxima execução.
- Proteções de reputação:
  - Teto diário configurável no painel.
  - Lista de supressão global.
  - Disjuntor: taxa de bounce > 3% → campanha pausa sozinha e notifica.

## 6. Testes e rollout

1. **Modo sombra (semana 1):** fluxos completos com Instantly em sandbox — e-mails
   gerados aparecem no painel para leitura, nada é enviado. Valida qualidade da
   personalização e das respostas.
2. **Piloto (semanas 2–3):** 10 envios/dia reais em nicho conhecido, com leitura de
   todas as conversas no painel. Warm-up do Instantly em paralelo.
3. **Produção:** aumento gradual até 20–50/dia.
- Testes automatizados no painel: consultas/mutações críticas (mudança de estágio,
  supressão). O restante é validado no piloto.

## 7. Evolução para produto (desenho, não implementação)

- `tenant_id` em todas as tabelas desde o início; painel já usa Supabase Auth.
- Fluxos do n8n leem configuração (nicho, oferta, tom, limites) do banco por
  campanha — nada fixo no fluxo.
- Virar produto = tela de cadastro/cobrança + conexão de caixas Instantly por
  cliente. Sem reescrita dos fluxos.

## 8. Fora do escopo da v1

- Prospecção fora do Brasil / multi-idioma.
- LinkedIn e WhatsApp como canais.
- Cobrança, times e permissões.
- Negociação de horários pela IA direto na agenda (v1 usa apenas o link Cal.com).

## 9. Critérios de sucesso

- Criar uma campanha descrevendo o nicho e, sem nenhuma ação manual, ver leads
  percorrerem o funil até **Reunião marcada**.
- Zero envio para e-mails inválidos ou suprimidos.
- Toda conversa auditável no painel com o raciocínio da IA.
- Bounce < 3% sustentado; campanha pausa sozinha se ultrapassar.
