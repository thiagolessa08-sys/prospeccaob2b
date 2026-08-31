# Plano 2 — Persistência e Enriquecimento

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao núcleo do Plano 1 uma camada de persistência testada contra Postgres real, e a capacidade de descobrir o decisor de uma empresa a partir do CNPJ — medindo, a cada tentativa, qual fonte acertou.

**Architecture:** Os repositórios falam SQL através de uma porta `Db` com a assinatura `query(text, params)`. Produção usa `pg.Pool`; teste usa `PGlite` (Postgres 18 em WASM, sem Docker) com a migration real aplicada. As duas implementações têm a mesma assinatura, então o mesmo repositório roda contra as duas e os testes exercitam as constraints de verdade. O enriquecimento é uma cadeia de fontes — grátis primeiro, paga depois — atrás de uma interface única, com o resultado de cada tentativa registrado em `events`.

**Tech Stack:** TypeScript (ESM), Node 24, Vitest, Zod, `pg`, `@electric-sql/pglite`, `fetch` nativo.

## Global Constraints

- ESM: imports relativos com extensão `.js`, nunca `__dirname` (use `import.meta.url`).
- Idioma de commits, comentários de código e mensagens de erro: **português brasileiro**, com acentuação correta.
- Cliente HTTP: **`fetch` nativo do Node**, injetado como dependência. Nunca axios, nunca node-fetch.
- Toda query SQL usa parâmetros posicionais (`$1`, `$2`). **Nunca** interpolação de string — é injeção de SQL.
- Todo repositório recebe a porta `Db` como primeiro parâmetro. Nenhum repositório abre conexão própria.
- Todo acesso a dados filtra por `tenant_id`. Uma query de leitura sem `tenant_id` no `where` é um defeito.
- Nenhum crédito de API paga é gasto antes de as fontes gratuitas falharem.
- Módulos de domínio continuam puros. Adaptadores de rede ficam em `src/enrichment/`, nunca em `src/domain/`.

**Referências:**
[Spec com emendas](../specs/2026-08-28-prospeccao-b2b-ia-design.md) ·
[Plano 1](2026-08-31-nucleo-dominio-ia.md) ·
[Handoff](2026-08-31-handoff-plano-2.md)

## Contratos externos verificados

Verificados diretamente contra as APIs/docs em 2026-08-31. Não invente campos
fora desta lista; se precisar de um campo que não está aqui, pare e pergunte.

**BrasilAPI** — `GET https://brasilapi.com.br/api/cnpj/v1/{cnpj}`, grátis, sem
autenticação. Campos usados: `razao_social`, `nome_fantasia`, `cnae_fiscal`,
`cnae_fiscal_descricao`, `uf`, `municipio`, `porte`, `capital_social`,
`descricao_situacao_cadastral`, `email`, `ddd_telefone_1`, `qsa[]`. Cada item
de `qsa` tem `nome_socio`, `qualificacao_socio`, `data_entrada_sociedade`.

**Hunter.io** — base `https://api.hunter.io/v2/`, auth por query param
`api_key`.
- `GET /email-finder?domain=&first_name=&last_name=&api_key=` →
  `data.email`, `data.score` (0–100), `data.verification.status`
- `GET /domain-search?domain=&department=&seniority=&limit=&api_key=` →
  `data.emails[]` com `value`, `confidence` (0–100), `first_name`,
  `last_name`, `position`, `department`, `verification.status`
- `GET /email-verifier?email=&api_key=` → `data.status` no conjunto
  `valid | invalid | accept_all | webmail | disposable | unknown`, `data.score`
- HTTP 202 = processamento assíncrono, repetir; 222 = timeout de SMTP, repetir

## Estrutura de arquivos

```
src/
├── db/
│   ├── port.ts                  interface Db — a fronteira SQL
│   ├── postgres.ts              adaptador de produção (pg.Pool)
│   ├── client.ts                (já existe; supabase-js, reservado ao painel)
│   └── repositories/
│       ├── campaigns.ts         cria e lê campanha
│       ├── companies.ts         insere em lote com dedup, lista pendentes
│       ├── leads.ts             cria e transiciona estágio
│       ├── messages.ts          anexa e carrega conversa
│       ├── suppression.ts       carrega e adiciona regras
│       └── events.ts            registra auditoria
├── http/
│   └── fetch-json.ts            timeout, retry e erro tipado
└── enrichment/
    ├── types.ts                 vocabulário próprio do enriquecimento
    ├── generic-emails.ts        rejeita caixa compartilhada
    ├── brasilapi.ts             adaptador do CNPJ (grátis)
    ├── hunter.ts                adaptador Hunter (pago)
    └── chain.ts                 orquestra a cadeia e mede a taxa de acerto

tests/
├── helpers/
│   ├── ai-mock.ts               (já existe)
│   ├── pg.ts                    sobe PGlite com a migration aplicada
│   └── http-mock.ts             fetch falso determinístico
├── db/repositories/*.test.ts    contra Postgres real
├── http/fetch-json.test.ts
└── enrichment/*.test.ts
```

---

### Task 1: Harness de banco com Postgres real

Fecha o maior risco herdado do Plano 1: nenhuma linha do SQL jamais rodou.

**Files:**
- Modify: `supabase/migrations/0001_initial_schema.sql` (remover a linha do pgcrypto)
- Modify: `package.json` (adicionar `pg`, `@types/pg`, `@electric-sql/pglite`)
- Create: `src/db/port.ts`
- Create: `tests/helpers/pg.ts`
- Test: `tests/db/migration.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `interface Db { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>; }`
  - `subirBanco(): Promise<BancoDeTeste>` onde
    `BancoDeTeste = { db: Db; tenantId: string; campaignId: string; encerrar(): Promise<void> }`

- [ ] **Step 1: Instalar as dependências**

```bash
npm install pg @electric-sql/pglite
npm install --save-dev @types/pg
```

- [ ] **Step 2: Remover a linha morta do pgcrypto**

Em `supabase/migrations/0001_initial_schema.sql`, apague a primeira linha:

```sql
create extension if not exists "pgcrypto";
```

`gen_random_uuid()` é nativo do Postgres desde a versão 13, então a extensão
nunca foi necessária. Ela também é a única coisa que impedia a migration de
rodar no PGlite — removê-la é o que torna esta task possível.

- [ ] **Step 3: Criar a porta `src/db/port.ts`**

```typescript
/**
 * Fronteira SQL do sistema.
 *
 * Esta assinatura é deliberadamente a interseção entre `pg.Pool` (produção) e
 * `PGlite` (teste): as duas expõem exatamente `query(text, params)` devolvendo
 * `{ rows }`. É isso que permite rodar o mesmo repositório contra um Postgres
 * de verdade nos testes, em vez de contra um mock.
 */
export interface Db {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}
```

- [ ] **Step 4: Criar o helper `tests/helpers/pg.ts`**

```typescript
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "../../src/db/port.js";

const aqui = dirname(fileURLToPath(import.meta.url));
const CAMINHO_MIGRATION = join(
  aqui,
  "../../supabase/migrations/0001_initial_schema.sql",
);

export const TENANT_ID = "11111111-1111-1111-1111-111111111111";
export const CAMPANHA_ID = "22222222-2222-2222-2222-222222222222";

export interface BancoDeTeste {
  db: Db;
  tenantId: string;
  campaignId: string;
  encerrar(): Promise<void>;
}

/**
 * Sobe um Postgres limpo em memória com a migration real aplicada, mais um
 * tenant e uma campanha de teste.
 *
 * Leva ~2,3 s. Chame uma vez por arquivo de teste (`beforeAll`), nunca por
 * teste — e isole os casos entre si usando dados diferentes, não recriando o
 * banco.
 */
export async function subirBanco(): Promise<BancoDeTeste> {
  const pglite = new PGlite();
  await pglite.exec(readFileSync(CAMINHO_MIGRATION, "utf8"));

  const db = pglite as unknown as Db;

  await db.query(`insert into tenants (id, name) values ($1, $2)`, [
    TENANT_ID,
    "SQL Tech",
  ]);
  await db.query(
    `insert into campaigns
       (id, tenant_id, name, niche_description, offer_description,
        scheduling_link, sender_first_name)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      CAMPANHA_ID,
      TENANT_ID,
      "Campanha de teste",
      "indústrias de alimentos em SC",
      "Consultoria de dados e BI",
      "https://cal.com/thiago/30min",
      "Thiago",
    ],
  );

  return {
    db,
    tenantId: TENANT_ID,
    campaignId: CAMPANHA_ID,
    encerrar: () => pglite.close(),
  };
}
```

- [ ] **Step 5: Escrever o teste que falha**

Criar `tests/db/migration.test.ts`. Este arquivo prova que o schema faz o que
diz — cada constraint que o Plano 1 escreveu sem nunca executar.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../helpers/pg.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

describe("migration", () => {
  it("cria as sete tabelas", async () => {
    const { rows } = await banco.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "campaigns",
      "companies",
      "events",
      "leads",
      "messages",
      "suppression_list",
      "tenants",
    ]);
  });

  it("ativa Row Level Security em todas as tabelas", async () => {
    const { rows } = await banco.db.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    expect(rows.length).toBe(7);
    for (const tabela of rows) {
      expect(
        tabela.relrowsecurity,
        `RLS desligado em ${tabela.relname}`,
      ).toBe(true);
    }
  });

  it("não define nenhuma policy, mantendo o banco fechado por padrão", async () => {
    const { rows } = await banco.db.query(
      `select policyname from pg_policies where schemaname = 'public'`,
    );
    expect(rows).toEqual([]);
  });
});

describe("constraints do schema", () => {
  it("barra CNPJ duplicado no mesmo tenant", async () => {
    const inserir = (nome: string) =>
      banco.db.query(
        `insert into companies (tenant_id, campaign_id, legal_name, source, cnpj)
         values ($1, $2, $3, 'cnpj', '11222333000181')`,
        [banco.tenantId, banco.campaignId, nome],
      );
    await inserir("Alfa LTDA");
    await expect(inserir("Alfa duplicada")).rejects.toThrow();
  });

  it("permite várias empresas sem CNPJ no mesmo tenant", async () => {
    const inserir = (nome: string) =>
      banco.db.query(
        `insert into companies (tenant_id, campaign_id, legal_name, source)
         values ($1, $2, $3, 'maps')`,
        [banco.tenantId, banco.campaignId, nome],
      );
    await inserir("Sem CNPJ um");
    await expect(inserir("Sem CNPJ dois")).resolves.toBeDefined();
  });

  it("trata e-mail de lead como único ignorando maiúsculas", async () => {
    const { rows } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do e-mail', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const empresaId = rows[0]!.id;
    const inserir = (email: string) =>
      banco.db.query(
        `insert into leads (tenant_id, campaign_id, company_id, email)
         values ($1, $2, $3, $4)`,
        [banco.tenantId, banco.campaignId, empresaId, email],
      );
    await inserir("Maria@Alfa.com");
    await expect(inserir("maria@alfa.com")).rejects.toThrow();
  });

  it("atualiza updated_at do lead a cada update", async () => {
    const { rows: criada } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do gatilho', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const { rows: lead } = await banco.db.query<{
      id: string;
      updated_at: Date;
    }>(
      `insert into leads (tenant_id, campaign_id, company_id, email)
       values ($1, $2, $3, 'gatilho@exemplo.com')
       returning id, updated_at`,
      [banco.tenantId, banco.campaignId, criada[0]!.id],
    );

    await new Promise((r) => setTimeout(r, 20));
    await banco.db.query(`update leads set full_name = 'Novo Nome' where id = $1`, [
      lead[0]!.id,
    ]);

    const { rows: depois } = await banco.db.query<{ updated_at: Date }>(
      `select updated_at from leads where id = $1`,
      [lead[0]!.id],
    );
    expect(depois[0]!.updated_at.getTime()).toBeGreaterThan(
      lead[0]!.updated_at.getTime(),
    );
  });

  it("barra a reentrega do mesmo webhook", async () => {
    const { rows: empresa } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do webhook', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const { rows: lead } = await banco.db.query<{ id: string }>(
      `insert into leads (tenant_id, campaign_id, company_id, email)
       values ($1, $2, $3, 'webhook@exemplo.com') returning id`,
      [banco.tenantId, banco.campaignId, empresa[0]!.id],
    );
    const inserir = () =>
      banco.db.query(
        `insert into messages (tenant_id, lead_id, direction, body, external_id)
         values ($1, $2, 'inbound', 'olá', 'evt_repetido')`,
        [banco.tenantId, lead[0]!.id],
      );
    await inserir();
    await expect(inserir()).rejects.toThrow();
  });

  it("permite várias mensagens sem external_id", async () => {
    const { rows: empresa } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa sem external', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    const { rows: lead } = await banco.db.query<{ id: string }>(
      `insert into leads (tenant_id, campaign_id, company_id, email)
       values ($1, $2, $3, 'semexternal@exemplo.com') returning id`,
      [banco.tenantId, banco.campaignId, empresa[0]!.id],
    );
    const inserir = (corpo: string) =>
      banco.db.query(
        `insert into messages (tenant_id, lead_id, direction, body)
         values ($1, $2, 'outbound', $3)`,
        [banco.tenantId, lead[0]!.id, corpo],
      );
    await inserir("primeira");
    await expect(inserir("segunda")).resolves.toBeDefined();
  });

  it("recusa um estágio de lead fora do enum", async () => {
    const { rows: empresa } = await banco.db.query<{ id: string }>(
      `insert into companies (tenant_id, campaign_id, legal_name, source)
       values ($1, $2, 'Empresa do enum', 'cnpj') returning id`,
      [banco.tenantId, banco.campaignId],
    );
    await expect(
      banco.db.query(
        `insert into leads (tenant_id, campaign_id, company_id, email, stage)
         values ($1, $2, $3, 'enum@exemplo.com', 'inventado')`,
        [banco.tenantId, banco.campaignId, empresa[0]!.id],
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/db/migration.test.ts`
Esperado: FAIL — não consegue resolver `tests/helpers/pg.js` ou `src/db/port.js`.

Depois de criar os arquivos dos Steps 3 e 4, rode de novo: deve PASSAR. Não há
"implementação" separada aqui — o código sob teste é a migration, que já
existe. Se algum caso falhar, o defeito está no SQL e é isso que a task veio
encontrar.

- [ ] **Step 7: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/db/migration.test.ts`
Esperado: PASS (10 testes).

- [ ] **Step 8: Criar o adaptador de produção `src/db/postgres.ts`**

```typescript
import pg from "pg";
import type { Db } from "./port.js";

let pool: pg.Pool | null = null;

/**
 * Conexão de produção. Recebe a connection string do Postgres do Supabase
 * (Project Settings → Database → Connection string), não a URL da API REST.
 */
export function getDb(connectionString: string): Db {
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}
```

- [ ] **Step 9: Corrigir os tipos de data em `src/db/types.ts`**

O Plano 1 declarou os campos de data como `string`, assumindo o supabase-js
(que devolve JSON, logo texto). Mas os repositórios passam a ler pelo `pg`, e
tanto `pg` quanto `PGlite` devolvem **`Date`** para `timestamptz` e `date`.
Verificado nesta máquina. Manter `string` deixaria o tipo mentindo, e um
consumidor futuro escrevendo `lead.created_at.slice(0, 10)` quebraria em
produção sem o compilador avisar.

Em `src/db/types.ts`, troque `string` por `Date` nestes campos:

- `Campaign.created_at`
- `Company.created_at`
- `Lead.resume_at` (fica `Date | null`)
- `Lead.created_at`
- `Lead.updated_at`
- `Message.created_at`
- `SuppressionEntry.created_at`

Não mexa em `filters`, `id`, nem em nenhum outro campo.

- [ ] **Step 10: Adicionar `DATABASE_URL` ao ambiente**

Em `src/config/env.ts`, acrescente ao `EnvSchema`:

```typescript
  DATABASE_URL: z.string().min(1),
```

Em `.env.example`, acrescente:

```
DATABASE_URL=postgresql://postgres:senha@db.xxxxx.supabase.co:5432/postgres
```

Atualize `tests/config/env.test.ts`: adicione `DATABASE_URL: "postgresql://x"`
ao objeto `validSource`, para que os três testes existentes continuem válidos.

- [ ] **Step 11: Rodar a suíte inteira e o typecheck**

Run: `npm test && npm run typecheck`
Esperado: tudo verde.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json supabase/migrations/0001_initial_schema.sql src/db/port.ts src/db/postgres.ts src/config/env.ts .env.example tests/helpers/pg.ts tests/db/migration.test.ts tests/config/env.test.ts
git commit -m "feat(db): roda a migration contra Postgres real nos testes"
```

---

### Task 2: Cliente HTTP com timeout, retry e erro tipado

**Files:**
- Create: `src/http/fetch-json.ts`
- Create: `tests/helpers/http-mock.ts`
- Test: `tests/http/fetch-json.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `class HttpError extends Error` com `status: number` e `corpo: string`
  - `type FetchLike = typeof fetch`
  - `fetchJson<T>(url: string, opcoes?: OpcoesHttp): Promise<T>` onde
    `OpcoesHttp = { fetch?: FetchLike; timeoutMs?: number; tentativas?: number; statusParaRepetir?: readonly number[] }`
  - `respostaJson(corpo: unknown, status?: number): Response` e
    `fetchFalso(respostas: readonly Response[]): FetchLike & { chamadas: string[] }` (no helper de teste)

- [ ] **Step 1: Criar o helper `tests/helpers/http-mock.ts`**

```typescript
import { vi } from "vitest";
import type { FetchLike } from "../../src/http/fetch-json.js";

/** Monta uma `Response` de JSON, como a API devolveria. */
export function respostaJson(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `Response` sem corpo, para status como 202 e 429. */
export function respostaVazia(status: number): Response {
  return new Response("", { status });
}

export interface FetchFalso {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  chamadas: string[];
}

/**
 * Devolve as respostas na ordem em que foram passadas, uma por chamada, e
 * registra cada URL pedida. Esgotada a lista, lança — um teste que chama mais
 * vezes do que previu está errado e deve falhar alto.
 */
export function fetchFalso(respostas: readonly Response[]): FetchFalso {
  let i = 0;
  const chamadas: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    chamadas.push(String(input));
    const resposta = respostas[i++];
    if (!resposta) {
      throw new Error(
        `fetchFalso: chamada ${i} sem resposta prevista (só ${respostas.length} foram configuradas)`,
      );
    }
    return resposta;
  }) as unknown as FetchFalso;
  fn.chamadas = chamadas;
  return fn;
}

/** `fetch` que sempre estoura o tempo, para testar o timeout. */
export function fetchQueTrava(): FetchLike {
  return (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    })) as FetchLike;
}
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `tests/http/fetch-json.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { fetchJson, HttpError } from "../../src/http/fetch-json.js";
import {
  respostaJson,
  respostaVazia,
  fetchFalso,
  fetchQueTrava,
} from "../helpers/http-mock.js";

describe("fetchJson", () => {
  it("devolve o JSON decodificado", async () => {
    const fake = fetchFalso([respostaJson({ nome: "Alfa" })]);
    const resultado = await fetchJson<{ nome: string }>(
      "https://exemplo.com/a",
      { fetch: fake },
    );
    expect(resultado).toEqual({ nome: "Alfa" });
    expect(fake.chamadas).toEqual(["https://exemplo.com/a"]);
  });

  it("lança HttpError com status e corpo em resposta 4xx", async () => {
    const fake = fetchFalso([respostaJson({ erro: "sem crédito" }, 402)]);
    const erro = await fetchJson("https://exemplo.com/a", {
      fetch: fake,
    }).catch((e) => e);
    expect(erro).toBeInstanceOf(HttpError);
    expect((erro as HttpError).status).toBe(402);
    expect((erro as HttpError).corpo).toContain("sem crédito");
  });

  it("não repete em erro 4xx, que não melhora com insistência", async () => {
    const fake = fetchFalso([respostaJson({ erro: "não achei" }, 404)]);
    await expect(
      fetchJson("https://exemplo.com/a", { fetch: fake, tentativas: 3 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fake.chamadas.length).toBe(1);
  });

  it("repete em 429 e devolve o sucesso seguinte", async () => {
    const fake = fetchFalso([
      respostaVazia(429),
      respostaJson({ nome: "Beta" }),
    ]);
    const resultado = await fetchJson<{ nome: string }>(
      "https://exemplo.com/a",
      { fetch: fake, tentativas: 3 },
    );
    expect(resultado).toEqual({ nome: "Beta" });
    expect(fake.chamadas.length).toBe(2);
  });

  it("repete em 5xx", async () => {
    const fake = fetchFalso([respostaVazia(503), respostaJson({ ok: true })]);
    await expect(
      fetchJson("https://exemplo.com/a", { fetch: fake, tentativas: 3 }),
    ).resolves.toEqual({ ok: true });
    expect(fake.chamadas.length).toBe(2);
  });

  it("desiste depois de esgotar as tentativas e lança o último erro", async () => {
    const fake = fetchFalso([
      respostaVazia(503),
      respostaVazia(503),
      respostaVazia(503),
    ]);
    const erro = await fetchJson("https://exemplo.com/a", {
      fetch: fake,
      tentativas: 3,
    }).catch((e) => e);
    expect((erro as HttpError).status).toBe(503);
    expect(fake.chamadas.length).toBe(3);
  });

  it("aceita status extras como repetíveis, para o 202 da Hunter", async () => {
    const fake = fetchFalso([respostaVazia(202), respostaJson({ ok: true })]);
    await expect(
      fetchJson("https://exemplo.com/a", {
        fetch: fake,
        tentativas: 2,
        statusParaRepetir: [202],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("aborta quando estoura o tempo", async () => {
    await expect(
      fetchJson("https://exemplo.com/a", {
        fetch: fetchQueTrava(),
        timeoutMs: 20,
        tentativas: 1,
      }),
    ).rejects.toThrow(/tempo/i);
  });

  it("lança erro claro quando o corpo não é JSON", async () => {
    const fake = fetchFalso([new Response("<html>ops</html>", { status: 200 })]);
    await expect(
      fetchJson("https://exemplo.com/a", { fetch: fake }),
    ).rejects.toThrow(/JSON/i);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/http/fetch-json.test.ts`
Esperado: FAIL — não consegue resolver `src/http/fetch-json.js`.

- [ ] **Step 4: Implementar `src/http/fetch-json.ts`**

```typescript
export type FetchLike = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly corpo: string,
    url: string,
  ) {
    super(`HTTP ${status} em ${url}: ${corpo.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export interface OpcoesHttp {
  fetch?: FetchLike;
  timeoutMs?: number;
  tentativas?: number;
  /** Status extras que valem uma nova tentativa, além de 429 e 5xx. */
  statusParaRepetir?: readonly number[];
}

const REPETIVEIS_PADRAO = [429];

function valeRepetir(status: number, extras: readonly number[]): boolean {
  return status >= 500 || REPETIVEIS_PADRAO.includes(status) || extras.includes(status);
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET de JSON com timeout, retry e erro tipado.
 *
 * Repete apenas o que melhora com insistência: 429, 5xx e os status extras que
 * o chamador declarar (a Hunter usa 202 e 222 para "ainda processando"). Um
 * 4xx é resposta definitiva do servidor e falha na primeira tentativa.
 */
export async function fetchJson<T>(
  url: string,
  opcoes: OpcoesHttp = {},
): Promise<T> {
  const {
    fetch: fetchFn = globalThis.fetch,
    timeoutMs = 15_000,
    tentativas = 2,
    statusParaRepetir = [],
  } = opcoes;

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const ultimaTentativa = tentativa === tentativas;
    const controlador = new AbortController();
    const relogio = setTimeout(() => controlador.abort(), timeoutMs);

    let resposta: Response;
    try {
      resposta = await fetchFn(url, { signal: controlador.signal });
    } catch (erro) {
      // Um timeout falha de imediato: se o servidor não respondeu em 15 s,
      // insistir no mesmo instante raramente ajuda e atrasa o lote inteiro.
      if (erro instanceof DOMException && erro.name === "AbortError") {
        throw new Error(`Tempo esgotado (${timeoutMs} ms) em ${url}`);
      }
      throw erro;
    } finally {
      clearTimeout(relogio);
    }

    if (resposta.ok && !statusParaRepetir.includes(resposta.status)) {
      const texto = await resposta.text();
      try {
        return JSON.parse(texto) as T;
      } catch {
        throw new Error(
          `Resposta de ${url} não é JSON válido: ${texto.slice(0, 200)}`,
        );
      }
    }

    const erro = new HttpError(resposta.status, await resposta.text(), url);
    if (!valeRepetir(resposta.status, statusParaRepetir) || ultimaTentativa) {
      throw erro;
    }
    await espera(300 * tentativa);
  }

  // Inalcançável: o laço sempre retorna ou lança. Presente para o compilador.
  throw new Error(`Falha ao chamar ${url}`);
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/http/fetch-json.test.ts`
Esperado: PASS (9 testes).

- [ ] **Step 6: Commit**

```bash
git add src/http/fetch-json.ts tests/helpers/http-mock.ts tests/http/fetch-json.test.ts
git commit -m "feat(http): cliente JSON com timeout, retry seletivo e erro tipado"
```

---

### Task 3: Repositório de campanhas

**Files:**
- Create: `src/db/repositories/campaigns.ts`
- Test: `tests/db/repositories/campaigns.test.ts`

**Interfaces:**
- Consumes: `Db` de `src/db/port.js`; `Campaign` de `src/db/types.js`; `subirBanco` de `tests/helpers/pg.js`.
- Produces:
  - `criarCampanha(db: Db, input: NovaCampanha): Promise<Campaign>` onde
    `NovaCampanha = { tenantId: string; name: string; nicheDescription: string; offerDescription: string; schedulingLink: string; senderFirstName: string; tone?: string; dailySendLimit?: number }`
  - `buscarCampanha(db: Db, tenantId: string, id: string): Promise<Campaign | null>`
  - `salvarFiltros(db: Db, tenantId: string, id: string, filtros: unknown): Promise<void>`
  - `listarCampanhasAtivas(db: Db, tenantId: string): Promise<Campaign[]>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/db/repositories/campaigns.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import {
  criarCampanha,
  buscarCampanha,
  salvarFiltros,
  listarCampanhasAtivas,
} from "../../../src/db/repositories/campaigns.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const base = {
  name: "Indústrias de alimentos",
  nicheDescription: "indústrias de alimentos em SC com 50+ funcionários",
  offerDescription: "Consultoria de dados e BI",
  schedulingLink: "https://cal.com/thiago/30min",
  senderFirstName: "Thiago",
};

describe("criarCampanha", () => {
  it("grava a campanha e devolve a linha criada", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
    });
    expect(campanha.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(campanha.niche_description).toBe(base.nicheDescription);
    expect(campanha.sender_first_name).toBe("Thiago");
    expect(campanha.status).toBe("active");
    expect(campanha.filters).toBeNull();
  });

  it("aplica os padrões de tom e teto diário", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Com padrões",
    });
    expect(campanha.daily_send_limit).toBe(20);
    expect(campanha.tone).toContain("consultivo");
  });

  it("respeita o teto diário informado", async () => {
    const campanha = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Teto próprio",
      dailySendLimit: 45,
    });
    expect(campanha.daily_send_limit).toBe(45);
  });
});

describe("buscarCampanha", () => {
  it("devolve a campanha pelo id", async () => {
    const criada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Para buscar",
    });
    const achada = await buscarCampanha(banco.db, banco.tenantId, criada.id);
    expect(achada?.name).toBe("Para buscar");
  });

  it("devolve null quando o id não existe", async () => {
    const achada = await buscarCampanha(
      banco.db,
      banco.tenantId,
      "99999999-9999-9999-9999-999999999999",
    );
    expect(achada).toBeNull();
  });

  it("não devolve campanha de outro tenant", async () => {
    const criada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Do tenant certo",
    });
    const outroTenant = "44444444-4444-4444-4444-444444444444";
    await banco.db.query(`insert into tenants (id, name) values ($1, 'Outro')`, [
      outroTenant,
    ]);
    const achada = await buscarCampanha(banco.db, outroTenant, criada.id);
    expect(achada).toBeNull();
  });
});

describe("salvarFiltros", () => {
  it("grava os filtros estruturados e devolve na leitura", async () => {
    const criada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Com filtros",
    });
    const filtros = { cnaes: ["1091101"], ufs: ["SC"], target_roles: ["Gerente de TI"] };
    await salvarFiltros(banco.db, banco.tenantId, criada.id, filtros);

    const relida = await buscarCampanha(banco.db, banco.tenantId, criada.id);
    expect(relida?.filters).toEqual(filtros);
  });
});

describe("listarCampanhasAtivas", () => {
  it("não devolve campanhas pausadas", async () => {
    const pausada = await criarCampanha(banco.db, {
      tenantId: banco.tenantId,
      ...base,
      name: "Pausada",
    });
    await banco.db.query(`update campaigns set status = 'paused' where id = $1`, [
      pausada.id,
    ]);
    const ativas = await listarCampanhasAtivas(banco.db, banco.tenantId);
    expect(ativas.map((c) => c.id)).not.toContain(pausada.id);
    expect(ativas.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/db/repositories/campaigns.test.ts`
Esperado: FAIL — não consegue resolver `src/db/repositories/campaigns.js`.

- [ ] **Step 3: Implementar `src/db/repositories/campaigns.ts`**

```typescript
import type { Db } from "../port.js";
import type { Campaign } from "../types.js";

export interface NovaCampanha {
  tenantId: string;
  name: string;
  nicheDescription: string;
  offerDescription: string;
  schedulingLink: string;
  senderFirstName: string;
  tone?: string;
  dailySendLimit?: number;
}

const COLUNAS = `id, tenant_id, name, niche_description, filters,
  offer_description, tone, scheduling_link, sender_first_name,
  daily_send_limit, status, created_at`;

export async function criarCampanha(
  db: Db,
  input: NovaCampanha,
): Promise<Campaign> {
  const { rows } = await db.query<Campaign>(
    `insert into campaigns
       (tenant_id, name, niche_description, offer_description,
        scheduling_link, sender_first_name, tone, daily_send_limit)
     values ($1, $2, $3, $4, $5, $6,
             coalesce($7, 'consultivo, direto, sem jargão'),
             coalesce($8, 20))
     returning ${COLUNAS}`,
    [
      input.tenantId,
      input.name,
      input.nicheDescription,
      input.offerDescription,
      input.schedulingLink,
      input.senderFirstName,
      input.tone ?? null,
      input.dailySendLimit ?? null,
    ],
  );
  return rows[0]!;
}

export async function buscarCampanha(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Campaign | null> {
  const { rows } = await db.query<Campaign>(
    `select ${COLUNAS} from campaigns where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

export async function salvarFiltros(
  db: Db,
  tenantId: string,
  id: string,
  filtros: unknown,
): Promise<void> {
  await db.query(
    `update campaigns set filters = $3 where tenant_id = $1 and id = $2`,
    [tenantId, id, JSON.stringify(filtros)],
  );
}

export async function listarCampanhasAtivas(
  db: Db,
  tenantId: string,
): Promise<Campaign[]> {
  const { rows } = await db.query<Campaign>(
    `select ${COLUNAS} from campaigns
     where tenant_id = $1 and status = 'active'
     order by created_at`,
    [tenantId],
  );
  return rows;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/db/repositories/campaigns.test.ts`
Esperado: PASS (8 testes).

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/campaigns.ts tests/db/repositories/campaigns.test.ts
git commit -m "feat(db): repositório de campanhas"
```

---

### Task 4: Repositório de empresas com dedup em lote

**Files:**
- Create: `src/db/repositories/companies.ts`
- Test: `tests/db/repositories/companies.test.ts`

**Interfaces:**
- Consumes: `Db`, `Company`, `subirBanco`.
- Produces:
  - `type NovaEmpresa = { tenantId: string; campaignId: string; cnpj: string | null; legalName: string; tradeName: string | null; website: string | null; city: string | null; uf: string | null; employeeCount: number | null; summary: string | null; source: string }`
  - `salvarEmpresas(db: Db, empresas: readonly NovaEmpresa[]): Promise<{ inseridas: number; ignoradas: number }>`
  - `listarPendentesDeEnriquecimento(db: Db, tenantId: string, campaignId: string, limite: number): Promise<Company[]>`
  - `marcarEnriquecimento(db: Db, tenantId: string, companyId: string, status: "enriched" | "failed"): Promise<void>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/db/repositories/companies.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import {
  salvarEmpresas,
  listarPendentesDeEnriquecimento,
  marcarEnriquecimento,
  type NovaEmpresa,
} from "../../../src/db/repositories/companies.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

function empresa(overrides: Partial<NovaEmpresa> = {}): NovaEmpresa {
  return {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    cnpj: null,
    legalName: "Alfa Alimentos LTDA",
    tradeName: "Alfa Alimentos",
    website: "https://alfa.com.br",
    city: "Joinville",
    uf: "SC",
    employeeCount: 80,
    summary: null,
    source: "cnpj",
    ...overrides,
  };
}

describe("salvarEmpresas", () => {
  it("insere um lote e conta o que entrou", async () => {
    const resultado = await salvarEmpresas(banco.db, [
      empresa({ cnpj: "11111111000101", legalName: "Um" }),
      empresa({ cnpj: "11111111000202", legalName: "Dois" }),
    ]);
    expect(resultado).toEqual({ inseridas: 2, ignoradas: 0 });
  });

  it("ignora CNPJ que já existe, sem falhar o lote inteiro", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "22222222000101", legalName: "Original" }),
    ]);
    const resultado = await salvarEmpresas(banco.db, [
      empresa({ cnpj: "22222222000101", legalName: "Repetida" }),
      empresa({ cnpj: "22222222000202", legalName: "Nova" }),
    ]);
    expect(resultado).toEqual({ inseridas: 1, ignoradas: 1 });
  });

  it("mantém o registro original quando ignora a duplicata", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "33333333000101", legalName: "Nome original" }),
    ]);
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "33333333000101", legalName: "Nome sobrescrito" }),
    ]);
    const { rows } = await banco.db.query<{ legal_name: string }>(
      `select legal_name from companies where cnpj = '33333333000101'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.legal_name).toBe("Nome original");
  });

  it("aceita várias empresas sem CNPJ no mesmo lote", async () => {
    const resultado = await salvarEmpresas(banco.db, [
      empresa({ cnpj: null, legalName: "Sem CNPJ A", source: "maps" }),
      empresa({ cnpj: null, legalName: "Sem CNPJ B", source: "maps" }),
    ]);
    expect(resultado.inseridas).toBe(2);
  });

  it("não faz nada com lote vazio", async () => {
    const resultado = await salvarEmpresas(banco.db, []);
    expect(resultado).toEqual({ inseridas: 0, ignoradas: 0 });
  });
});

describe("listarPendentesDeEnriquecimento", () => {
  it("devolve só quem está pendente, respeitando o limite", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "44444444000101", legalName: "Pendente 1" }),
      empresa({ cnpj: "44444444000202", legalName: "Pendente 2" }),
      empresa({ cnpj: "44444444000303", legalName: "Pendente 3" }),
    ]);
    const pendentes = await listarPendentesDeEnriquecimento(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      2,
    );
    expect(pendentes).toHaveLength(2);
    for (const p of pendentes) expect(p.enrichment_status).toBe("pending");
  });

  it("não devolve empresa já enriquecida", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "55555555000101", legalName: "Já enriquecida" }),
    ]);
    const { rows } = await banco.db.query<{ id: string }>(
      `select id from companies where cnpj = '55555555000101'`,
    );
    await marcarEnriquecimento(banco.db, banco.tenantId, rows[0]!.id, "enriched");

    const pendentes = await listarPendentesDeEnriquecimento(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      50,
    );
    expect(pendentes.map((p) => p.id)).not.toContain(rows[0]!.id);
  });

  it("não devolve empresa cujo enriquecimento falhou", async () => {
    await salvarEmpresas(banco.db, [
      empresa({ cnpj: "66666666000101", legalName: "Falhou" }),
    ]);
    const { rows } = await banco.db.query<{ id: string }>(
      `select id from companies where cnpj = '66666666000101'`,
    );
    await marcarEnriquecimento(banco.db, banco.tenantId, rows[0]!.id, "failed");

    const pendentes = await listarPendentesDeEnriquecimento(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      50,
    );
    expect(pendentes.map((p) => p.id)).not.toContain(rows[0]!.id);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/db/repositories/companies.test.ts`
Esperado: FAIL — não consegue resolver `src/db/repositories/companies.js`.

- [ ] **Step 3: Implementar `src/db/repositories/companies.ts`**

```typescript
import type { Db } from "../port.js";
import type { Company } from "../types.js";

export interface NovaEmpresa {
  tenantId: string;
  campaignId: string;
  cnpj: string | null;
  legalName: string;
  tradeName: string | null;
  website: string | null;
  city: string | null;
  uf: string | null;
  employeeCount: number | null;
  summary: string | null;
  source: string;
}

const COLUNAS = `id, tenant_id, campaign_id, cnpj, legal_name, trade_name,
  website, city, uf, employee_count, summary, source, enrichment_status,
  created_at`;

/**
 * Insere o lote deixando o banco resolver a duplicidade.
 *
 * `on conflict do nothing` sobre o índice parcial de CNPJ mantém o registro
 * original e devolve menos linhas do que foram enviadas — a diferença é a
 * contagem de ignoradas. Fazer o dedup em SQL, e não em memória, é o que torna
 * a operação segura quando dois fluxos rodam ao mesmo tempo.
 */
export async function salvarEmpresas(
  db: Db,
  empresas: readonly NovaEmpresa[],
): Promise<{ inseridas: number; ignoradas: number }> {
  if (empresas.length === 0) return { inseridas: 0, ignoradas: 0 };

  const colunasPorLinha = 11;
  const valores: unknown[] = [];
  const marcadores = empresas.map((e, i) => {
    const base = i * colunasPorLinha;
    valores.push(
      e.tenantId,
      e.campaignId,
      e.cnpj,
      e.legalName,
      e.tradeName,
      e.website,
      e.city,
      e.uf,
      e.employeeCount,
      e.summary,
      e.source,
    );
    const p = Array.from(
      { length: colunasPorLinha },
      (_, j) => `$${base + j + 1}`,
    );
    return `(${p.join(", ")})`;
  });

  const { rows } = await db.query<{ id: string }>(
    `insert into companies
       (tenant_id, campaign_id, cnpj, legal_name, trade_name, website,
        city, uf, employee_count, summary, source)
     values ${marcadores.join(", ")}
     on conflict do nothing
     returning id`,
    valores,
  );

  return {
    inseridas: rows.length,
    ignoradas: empresas.length - rows.length,
  };
}

export async function listarPendentesDeEnriquecimento(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<Company[]> {
  const { rows } = await db.query<Company>(
    `select ${COLUNAS} from companies
     where tenant_id = $1 and campaign_id = $2 and enrichment_status = 'pending'
     order by created_at
     limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}

export async function marcarEnriquecimento(
  db: Db,
  tenantId: string,
  companyId: string,
  status: "enriched" | "failed",
): Promise<void> {
  await db.query(
    `update companies set enrichment_status = $3
     where tenant_id = $1 and id = $2`,
    [tenantId, companyId, status],
  );
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/db/repositories/companies.test.ts`
Esperado: PASS (8 testes).

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/companies.ts tests/db/repositories/companies.test.ts
git commit -m "feat(db): repositório de empresas com dedup em lote no banco"
```

---

### Task 5: Repositório de leads com transições validadas

**Files:**
- Create: `src/db/repositories/leads.ts`
- Test: `tests/db/repositories/leads.test.ts`

**Interfaces:**
- Consumes: `Db`, `Lead`, `LeadStage`; `assertTransition` de `src/domain/stages.js`.
- Produces:
  - `type NovoLead = { tenantId: string; campaignId: string; companyId: string; fullName: string | null; roleTitle: string | null; email: string; emailVerified: boolean }`
  - `criarLead(db: Db, input: NovoLead): Promise<Lead>`
  - `buscarLead(db: Db, tenantId: string, id: string): Promise<Lead | null>`
  - `transicionarLead(db: Db, tenantId: string, id: string, para: LeadStage, extras?: { discardReason?: string; handoffReason?: string; needsHuman?: boolean; resumeAt?: Date }): Promise<Lead>`
  - `incrementarTrocas(db: Db, tenantId: string, id: string): Promise<number>`
  - `listarProntosParaContato(db: Db, tenantId: string, campaignId: string, limite: number): Promise<Lead[]>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/db/repositories/leads.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import {
  criarLead,
  buscarLead,
  transicionarLead,
  incrementarTrocas,
  listarProntosParaContato,
} from "../../../src/db/repositories/leads.js";

let banco: BancoDeTeste;
let empresaId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "77777777000101",
      legalName: "Empresa dos leads",
      tradeName: null,
      website: null,
      city: null,
      uf: null,
      employeeCount: null,
      summary: null,
      source: "cnpj",
    },
  ]);
  const { rows } = await banco.db.query<{ id: string }>(
    `select id from companies where cnpj = '77777777000101'`,
  );
  empresaId = rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

let contador = 0;
function novoLead(overrides: Partial<Parameters<typeof criarLead>[1]> = {}) {
  contador += 1;
  return {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: empresaId,
    fullName: "Maria Souza",
    roleTitle: "Gerente de TI",
    email: `maria${contador}@empresa.com.br`,
    emailVerified: true,
    ...overrides,
  };
}

describe("criarLead", () => {
  it("cria o lead já no estágio enriched", async () => {
    const lead = await criarLead(banco.db, novoLead());
    expect(lead.stage).toBe("enriched");
    expect(lead.exchange_count).toBe(0);
    expect(lead.needs_human).toBe(false);
  });
});

describe("transicionarLead", () => {
  it("avança pelo caminho feliz do funil", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const contatado = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "contacted",
    );
    expect(contatado.stage).toBe("contacted");
  });

  it("recusa uma transição inválida antes de tocar o banco", async () => {
    const lead = await criarLead(banco.db, novoLead());
    await expect(
      transicionarLead(banco.db, banco.tenantId, lead.id, "meeting_booked"),
    ).rejects.toThrow(/Transição de estágio inválida/);

    const inalterado = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(inalterado?.stage).toBe("enriched");
  });

  it("grava o motivo do descarte", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const descartado = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "discarded",
      { discardReason: "recusa do lead" },
    );
    expect(descartado.stage).toBe("discarded");
    expect(descartado.discard_reason).toBe("recusa do lead");
  });

  it("marca needs_human junto com o motivo do repasse", async () => {
    const lead = await criarLead(banco.db, novoLead());
    await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted");
    const emConversa = await transicionarLead(
      banco.db,
      banco.tenantId,
      lead.id,
      "in_conversation",
      { needsHuman: true, handoffReason: "conversa longa sem desfecho" },
    );
    expect(emConversa.needs_human).toBe(true);
    expect(emConversa.handoff_reason).toBe("conversa longa sem desfecho");
  });

  it("grava a data de retomada", async () => {
    const lead = await criarLead(banco.db, novoLead());
    const quando = new Date("2026-12-01T12:00:00.000Z");
    await transicionarLead(banco.db, banco.tenantId, lead.id, "contacted", {
      resumeAt: quando,
    });
    const relido = await buscarLead(banco.db, banco.tenantId, lead.id);
    expect(relido!.resume_at!.toISOString()).toBe(quando.toISOString());
  });

  it("lança quando o lead não existe", async () => {
    await expect(
      transicionarLead(
        banco.db,
        banco.tenantId,
        "99999999-9999-9999-9999-999999999999",
        "contacted",
      ),
    ).rejects.toThrow(/não encontrado/i);
  });
});

describe("incrementarTrocas", () => {
  it("soma um e devolve o valor novo", async () => {
    const lead = await criarLead(banco.db, novoLead());
    expect(await incrementarTrocas(banco.db, banco.tenantId, lead.id)).toBe(1);
    expect(await incrementarTrocas(banco.db, banco.tenantId, lead.id)).toBe(2);
  });
});

describe("listarProntosParaContato", () => {
  it("devolve só leads enriched com e-mail verificado", async () => {
    const verificado = await criarLead(banco.db, novoLead());
    const naoVerificado = await criarLead(
      banco.db,
      novoLead({ emailVerified: false }),
    );
    const jaContatado = await criarLead(banco.db, novoLead());
    await transicionarLead(banco.db, banco.tenantId, jaContatado.id, "contacted");

    const prontos = await listarProntosParaContato(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      50,
    );
    const ids = prontos.map((l) => l.id);
    expect(ids).toContain(verificado.id);
    expect(ids).not.toContain(naoVerificado.id);
    expect(ids).not.toContain(jaContatado.id);
  });

  it("respeita o limite pedido", async () => {
    await criarLead(banco.db, novoLead());
    await criarLead(banco.db, novoLead());
    const prontos = await listarProntosParaContato(
      banco.db,
      banco.tenantId,
      banco.campaignId,
      1,
    );
    expect(prontos).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/db/repositories/leads.test.ts`
Esperado: FAIL — não consegue resolver `src/db/repositories/leads.js`.

- [ ] **Step 3: Implementar `src/db/repositories/leads.ts`**

```typescript
import type { Db } from "../port.js";
import type { Lead, LeadStage } from "../types.js";
import { assertTransition } from "../../domain/stages.js";

export interface NovoLead {
  tenantId: string;
  campaignId: string;
  companyId: string;
  fullName: string | null;
  roleTitle: string | null;
  email: string;
  emailVerified: boolean;
}

export interface ExtrasDaTransicao {
  discardReason?: string;
  handoffReason?: string;
  needsHuman?: boolean;
  resumeAt?: Date;
}

const COLUNAS = `id, tenant_id, campaign_id, company_id, full_name, role_title,
  email, email_verified, stage, discard_reason, handoff_reason, exchange_count,
  resume_at, needs_human, created_at, updated_at`;

export async function criarLead(db: Db, input: NovoLead): Promise<Lead> {
  const { rows } = await db.query<Lead>(
    `insert into leads
       (tenant_id, campaign_id, company_id, full_name, role_title,
        email, email_verified)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${COLUNAS}`,
    [
      input.tenantId,
      input.campaignId,
      input.companyId,
      input.fullName,
      input.roleTitle,
      input.email,
      input.emailVerified,
    ],
  );
  return rows[0]!;
}

export async function buscarLead(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Lead | null> {
  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/**
 * Move o lead de estágio, validando a transição antes de escrever.
 *
 * A validação usa a mesma máquina de estados do domínio (`assertTransition`),
 * então o banco nunca guarda um caminho que o funil não permite — e o lead
 * fica intacto quando a transição é recusada.
 */
export async function transicionarLead(
  db: Db,
  tenantId: string,
  id: string,
  para: LeadStage,
  extras: ExtrasDaTransicao = {},
): Promise<Lead> {
  const atual = await buscarLead(db, tenantId, id);
  if (!atual) {
    throw new Error(`Lead ${id} não encontrado no tenant ${tenantId}.`);
  }

  assertTransition(atual.stage, para);

  const { rows } = await db.query<Lead>(
    `update leads set
       stage = $3,
       discard_reason = coalesce($4, discard_reason),
       handoff_reason = coalesce($5, handoff_reason),
       needs_human = coalesce($6, needs_human),
       resume_at = coalesce($7, resume_at)
     where tenant_id = $1 and id = $2
     returning ${COLUNAS}`,
    [
      tenantId,
      id,
      para,
      extras.discardReason ?? null,
      extras.handoffReason ?? null,
      extras.needsHuman ?? null,
      extras.resumeAt ?? null,
    ],
  );
  return rows[0]!;
}

export async function incrementarTrocas(
  db: Db,
  tenantId: string,
  id: string,
): Promise<number> {
  const { rows } = await db.query<{ exchange_count: number }>(
    `update leads set exchange_count = exchange_count + 1
     where tenant_id = $1 and id = $2
     returning exchange_count`,
    [tenantId, id],
  );
  if (!rows[0]) {
    throw new Error(`Lead ${id} não encontrado no tenant ${tenantId}.`);
  }
  return rows[0].exchange_count;
}

/** Leads prontos para o primeiro contato: enriquecidos e com e-mail verificado. */
export async function listarProntosParaContato(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<Lead[]> {
  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads
     where tenant_id = $1 and campaign_id = $2
       and stage = 'enriched' and email_verified = true
     order by created_at
     limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/db/repositories/leads.test.ts`
Esperado: PASS (10 testes).

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/leads.ts tests/db/repositories/leads.test.ts
git commit -m "feat(db): repositório de leads com transições validadas pelo domínio"
```

---

### Task 6: Repositórios de mensagens, supressão e eventos

**Files:**
- Create: `src/db/repositories/messages.ts`
- Create: `src/db/repositories/suppression.ts`
- Create: `src/db/repositories/events.ts`
- Test: `tests/db/repositories/messages.test.ts`
- Test: `tests/db/repositories/suppression.test.ts`

**Interfaces:**
- Consumes: `Db`, `Message`, `ReplyIntent`; `SuppressionRule` de `src/domain/suppression.js`.
- Produces:
  - `anexarMensagem(db, input: NovaMensagem): Promise<Message | null>` — devolve `null` quando o `externalId` já existe (reentrega de webhook)
  - `carregarConversa(db, tenantId, leadId): Promise<Message[]>`
  - `carregarRegrasDeSupressao(db, tenantId): Promise<SuppressionRule[]>`
  - `adicionarSupressao(db, tenantId, regra: SuppressionRule, motivo: string): Promise<void>`
  - `registrarEvento(db, input: { tenantId: string | null; leadId: string | null; kind: string; payload?: unknown }): Promise<void>`

- [ ] **Step 1: Escrever o teste de mensagens**

Criar `tests/db/repositories/messages.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { salvarEmpresas } from "../../../src/db/repositories/companies.js";
import { criarLead } from "../../../src/db/repositories/leads.js";
import {
  anexarMensagem,
  carregarConversa,
} from "../../../src/db/repositories/messages.js";

let banco: BancoDeTeste;
let leadId: string;

beforeAll(async () => {
  banco = await subirBanco();
  await salvarEmpresas(banco.db, [
    {
      tenantId: banco.tenantId,
      campaignId: banco.campaignId,
      cnpj: "88888888000101",
      legalName: "Empresa das mensagens",
      tradeName: null,
      website: null,
      city: null,
      uf: null,
      employeeCount: null,
      summary: null,
      source: "cnpj",
    },
  ]);
  const { rows } = await banco.db.query<{ id: string }>(
    `select id from companies where cnpj = '88888888000101'`,
  );
  const lead = await criarLead(banco.db, {
    tenantId: banco.tenantId,
    campaignId: banco.campaignId,
    companyId: rows[0]!.id,
    fullName: "João",
    roleTitle: "Diretor",
    email: "joao@mensagens.com.br",
    emailVerified: true,
  });
  leadId = lead.id;
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

describe("anexarMensagem", () => {
  it("grava uma mensagem enviada", async () => {
    const msg = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "outbound",
      subject: "Integração de dados",
      body: "Olá João...",
    });
    expect(msg?.direction).toBe("outbound");
    expect(msg?.subject).toBe("Integração de dados");
  });

  it("grava a classificação junto da mensagem recebida", async () => {
    const msg = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "Quanto custa?",
      intent: "question_or_objection",
      confidence: 0.91,
      aiReasoning: "Perguntou preço antes de aceitar conversar.",
      externalId: "evt_classificada",
    });
    expect(msg?.intent).toBe("question_or_objection");
    expect(Number(msg?.confidence)).toBeCloseTo(0.91);
    expect(msg?.ai_reasoning).toContain("preço");
  });

  it("devolve null na reentrega do mesmo webhook, em vez de lançar", async () => {
    const primeira = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "mensagem única",
      externalId: "evt_unico",
    });
    expect(primeira).not.toBeNull();

    const repetida = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "inbound",
      body: "mensagem única",
      externalId: "evt_unico",
    });
    expect(repetida).toBeNull();
  });

  it("permite várias mensagens sem external_id", async () => {
    const a = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "outbound",
      body: "follow-up um",
    });
    const b = await anexarMensagem(banco.db, {
      tenantId: banco.tenantId,
      leadId,
      direction: "outbound",
      body: "follow-up dois",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});

describe("carregarConversa", () => {
  it("devolve as mensagens do lead em ordem cronológica", async () => {
    const conversa = await carregarConversa(banco.db, banco.tenantId, leadId);
    expect(conversa.length).toBeGreaterThan(1);
    for (let i = 1; i < conversa.length; i++) {
      expect(conversa[i]!.created_at.getTime()).toBeGreaterThanOrEqual(
        conversa[i - 1]!.created_at.getTime(),
      );
    }
  });

  it("devolve lista vazia para lead sem mensagens", async () => {
    const conversa = await carregarConversa(
      banco.db,
      banco.tenantId,
      "99999999-9999-9999-9999-999999999999",
    );
    expect(conversa).toEqual([]);
  });
});
```

- [ ] **Step 2: Escrever o teste de supressão**

Criar `tests/db/repositories/suppression.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import {
  carregarRegrasDeSupressao,
  adicionarSupressao,
} from "../../../src/db/repositories/suppression.js";
import { isSuppressed } from "../../../src/domain/suppression.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

describe("supressão", () => {
  it("começa vazia", async () => {
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toEqual([]);
  });

  it("grava e devolve uma regra de e-mail", async () => {
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "email", value: "chato@empresa.com" },
      "pedido de descadastro",
    );
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({
      kind: "email",
      value: "chato@empresa.com",
    });
  });

  it("grava e devolve uma regra de domínio", async () => {
    await adicionarSupressao(
      banco.db,
      banco.tenantId,
      { kind: "domain", value: "concorrente.com.br" },
      "concorrente",
    );
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(regras).toContainEqual({
      kind: "domain",
      value: "concorrente.com.br",
    });
  });

  it("é idempotente: adicionar duas vezes não duplica nem lança", async () => {
    const regra = { kind: "email", value: "repetido@empresa.com" } as const;
    await adicionarSupressao(banco.db, banco.tenantId, regra, "primeiro");
    await adicionarSupressao(banco.db, banco.tenantId, regra, "segundo");
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    const iguais = regras.filter((r) => r.value === "repetido@empresa.com");
    expect(iguais).toHaveLength(1);
  });

  it("liga com a regra pura do domínio", async () => {
    const regras = await carregarRegrasDeSupressao(banco.db, banco.tenantId);
    expect(isSuppressed("qualquer@concorrente.com.br", regras)).toBe(true);
    expect(isSuppressed("alvo@empresa-nova.com.br", regras)).toBe(false);
  });
});
```

- [ ] **Step 3: Rodar os dois testes e confirmar que falham**

Run: `npm test -- tests/db/repositories/messages.test.ts tests/db/repositories/suppression.test.ts`
Esperado: FAIL — não consegue resolver os módulos de repositório.

- [ ] **Step 4: Implementar `src/db/repositories/messages.ts`**

```typescript
import type { Db } from "../port.js";
import type { Message, ReplyIntent } from "../types.js";

export interface NovaMensagem {
  tenantId: string;
  leadId: string;
  direction: "outbound" | "inbound";
  body: string;
  subject?: string;
  intent?: ReplyIntent;
  confidence?: number;
  aiReasoning?: string;
  externalId?: string;
}

const COLUNAS = `id, tenant_id, lead_id, direction, subject, body, intent,
  confidence, ai_reasoning, external_id, created_at`;

/**
 * Anexa uma mensagem à conversa.
 *
 * Devolve `null` quando o `externalId` já existe. O Instantly repete a entrega
 * do webhook em qualquer resposta não-2xx, e sem isso a reentrega geraria uma
 * segunda classificação e uma segunda réplica **enviada ao lead**. Deixar o
 * índice único decidir, e tratar o conflito como "já processei", é o que torna
 * o webhook idempotente.
 */
export async function anexarMensagem(
  db: Db,
  input: NovaMensagem,
): Promise<Message | null> {
  const { rows } = await db.query<Message>(
    `insert into messages
       (tenant_id, lead_id, direction, subject, body, intent, confidence,
        ai_reasoning, external_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict do nothing
     returning ${COLUNAS}`,
    [
      input.tenantId,
      input.leadId,
      input.direction,
      input.subject ?? null,
      input.body,
      input.intent ?? null,
      input.confidence ?? null,
      input.aiReasoning ?? null,
      input.externalId ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function carregarConversa(
  db: Db,
  tenantId: string,
  leadId: string,
): Promise<Message[]> {
  const { rows } = await db.query<Message>(
    `select ${COLUNAS} from messages
     where tenant_id = $1 and lead_id = $2
     order by created_at, id`,
    [tenantId, leadId],
  );
  return rows;
}
```

- [ ] **Step 5: Implementar `src/db/repositories/suppression.ts`**

```typescript
import type { Db } from "../port.js";
import type { SuppressionRule } from "../../domain/suppression.js";

export async function carregarRegrasDeSupressao(
  db: Db,
  tenantId: string,
): Promise<SuppressionRule[]> {
  const { rows } = await db.query<{ kind: "email" | "domain"; value: string }>(
    `select kind, value from suppression_list where tenant_id = $1`,
    [tenantId],
  );
  return rows.map((r) => ({ kind: r.kind, value: r.value }));
}

/** Idempotente: a mesma regra pode ser adicionada quantas vezes for. */
export async function adicionarSupressao(
  db: Db,
  tenantId: string,
  regra: SuppressionRule,
  motivo: string,
): Promise<void> {
  await db.query(
    `insert into suppression_list (tenant_id, kind, value, reason)
     values ($1, $2, $3, $4)
     on conflict do nothing`,
    [tenantId, regra.kind, regra.value, motivo],
  );
}
```

- [ ] **Step 6: Implementar `src/db/repositories/events.ts`**

```typescript
import type { Db } from "../port.js";

export interface NovoEvento {
  tenantId: string | null;
  leadId: string | null;
  kind: string;
  payload?: unknown;
}

/**
 * Trilha de auditoria. `tenant_id` e `lead_id` são anuláveis de propósito:
 * falhas que acontecem antes de resolver o tenant também precisam ser
 * registradas.
 */
export async function registrarEvento(
  db: Db,
  input: NovoEvento,
): Promise<void> {
  await db.query(
    `insert into events (tenant_id, lead_id, kind, payload)
     values ($1, $2, $3, $4)`,
    [
      input.tenantId,
      input.leadId,
      input.kind,
      input.payload === undefined ? null : JSON.stringify(input.payload),
    ],
  );
}
```

- [ ] **Step 7: Rodar os testes e confirmar que passam**

Run: `npm test -- tests/db/repositories/`
Esperado: PASS (todos os arquivos de repositório).

- [ ] **Step 8: Commit**

```bash
git add src/db/repositories/messages.ts src/db/repositories/suppression.ts src/db/repositories/events.ts tests/db/repositories/messages.test.ts tests/db/repositories/suppression.test.ts
git commit -m "feat(db): repositórios de mensagens idempotentes, supressão e eventos"
```

---

### Task 7: Rejeição de caixa de e-mail genérica

Uma caixa compartilhada não é um decisor. Sem esta trava, o funil enche de
`contato@` e o primeiro e-mail vai parar numa caixa que ninguém lê — que é
exatamente o modo de falha que a pesquisa apontou como provável no Brasil.

**Files:**
- Create: `src/enrichment/generic-emails.ts`
- Test: `tests/enrichment/generic-emails.test.ts`

**Interfaces:**
- Consumes: `extractDomain` de `src/domain/suppression.js`.
- Produces:
  - `PREFIXOS_GENERICOS: readonly string[]`
  - `ehEmailGenerico(email: string): boolean`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/enrichment/generic-emails.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ehEmailGenerico } from "../../src/enrichment/generic-emails.js";

describe("ehEmailGenerico", () => {
  it("reconhece as caixas compartilhadas mais comuns no Brasil", () => {
    for (const email of [
      "contato@empresa.com.br",
      "comercial@empresa.com.br",
      "vendas@empresa.com.br",
      "sac@empresa.com.br",
      "atendimento@empresa.com.br",
      "financeiro@empresa.com.br",
      "rh@empresa.com.br",
      "faleconosco@empresa.com.br",
    ]) {
      expect(ehEmailGenerico(email), email).toBe(true);
    }
  });

  it("reconhece as caixas genéricas em inglês", () => {
    for (const email of [
      "info@empresa.com",
      "sales@empresa.com",
      "support@empresa.com",
      "admin@empresa.com",
      "hello@empresa.com",
      "noreply@empresa.com",
    ]) {
      expect(ehEmailGenerico(email), email).toBe(true);
    }
  });

  it("aceita e-mail de pessoa", () => {
    for (const email of [
      "maria.souza@empresa.com.br",
      "joao@empresa.com.br",
      "m.souza@empresa.com.br",
    ]) {
      expect(ehEmailGenerico(email), email).toBe(false);
    }
  });

  it("ignora maiúsculas e espaços", () => {
    expect(ehEmailGenerico("  Contato@Empresa.COM.BR ")).toBe(true);
  });

  it("não confunde um nome que começa igual a um prefixo genérico", () => {
    expect(ehEmailGenerico("contatore@empresa.com.br")).toBe(false);
    expect(ehEmailGenerico("informatica@empresa.com.br")).toBe(false);
  });

  it("trata e-mail malformado como genérico, por segurança", () => {
    expect(ehEmailGenerico("sem-arroba")).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/enrichment/generic-emails.test.ts`
Esperado: FAIL — não consegue resolver `src/enrichment/generic-emails.js`.

- [ ] **Step 3: Implementar `src/enrichment/generic-emails.ts`**

```typescript
import { normalizeEmail } from "../domain/suppression.js";

/**
 * Prefixos de caixa compartilhada. A comparação é por igualdade exata da parte
 * local, nunca por prefixo de string: "informatica@" começa com "info" mas é
 * um endereço legítimo de setor, e "contatore@" começa com "contato".
 */
export const PREFIXOS_GENERICOS: readonly string[] = [
  "contato",
  "comercial",
  "vendas",
  "sac",
  "atendimento",
  "financeiro",
  "rh",
  "faleconosco",
  "fale-conosco",
  "ouvidoria",
  "compras",
  "juridico",
  "marketing",
  "suporte",
  "info",
  "sales",
  "support",
  "admin",
  "hello",
  "hi",
  "contact",
  "office",
  "team",
  "help",
  "noreply",
  "no-reply",
  "donotreply",
  "postmaster",
  "webmaster",
  "abuse",
  "billing",
];

/**
 * Um e-mail malformado conta como genérico: preferimos descartar o candidato a
 * gravar como decisor um endereço que não conseguimos sequer interpretar.
 */
export function ehEmailGenerico(email: string): boolean {
  let normalizado: string;
  try {
    normalizado = normalizeEmail(email);
  } catch {
    return true;
  }
  const parteLocal = normalizado.slice(0, normalizado.lastIndexOf("@"));
  return PREFIXOS_GENERICOS.includes(parteLocal);
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/enrichment/generic-emails.test.ts`
Esperado: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/enrichment/generic-emails.ts tests/enrichment/generic-emails.test.ts
git commit -m "feat(enrichment): rejeita caixa de e-mail compartilhada como decisor"
```

---

### Task 8: Adaptador BrasilAPI

**Files:**
- Create: `src/enrichment/types.ts`
- Create: `src/enrichment/brasilapi.ts`
- Test: `tests/enrichment/brasilapi.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `FetchLike`, `HttpError` de `src/http/fetch-json.js`.
- Produces (em `types.ts`):
  - `type StatusVerificacao = "valid" | "accept_all" | "invalid" | "unknown"`
  - `type CandidatoDecisor = { nome: string | null; cargo: string | null; email: string | null; confianca: number; verificacao: StatusVerificacao; fonte: FonteDoDecisor }`
  - `type FonteDoDecisor = "cnpj_qsa" | "cnpj_email" | "hunter_finder" | "hunter_domain"`
  - `type DadosDaEmpresa = { cnpj: string; razaoSocial: string; nomeFantasia: string | null; cnaePrincipal: string; descricaoCnae: string; uf: string | null; municipio: string | null; porte: string | null; ativa: boolean; email: string | null; telefone: string | null; socios: readonly SocioOuAdmin[] }`
  - `type SocioOuAdmin = { nome: string; qualificacao: string }`
- Produces (em `brasilapi.ts`):
  - `buscarEmpresaPorCnpj(cnpj: string, deps?: { fetch?: FetchLike }): Promise<DadosDaEmpresa | null>`
  - `normalizarCnpj(cnpj: string): string`

- [ ] **Step 1: Criar `src/enrichment/types.ts`**

```typescript
/** Vocabulário próprio do enriquecimento. Nenhum termo de fornecedor vaza daqui. */

export type StatusVerificacao = "valid" | "accept_all" | "invalid" | "unknown";

export type FonteDoDecisor =
  | "cnpj_qsa"
  | "cnpj_email"
  | "hunter_finder"
  | "hunter_domain";

export interface CandidatoDecisor {
  nome: string | null;
  cargo: string | null;
  email: string | null;
  /** 0 a 100. Fontes sem score próprio recebem um valor sintético documentado. */
  confianca: number;
  verificacao: StatusVerificacao;
  fonte: FonteDoDecisor;
}

export interface SocioOuAdmin {
  nome: string;
  qualificacao: string;
}

export interface DadosDaEmpresa {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  cnaePrincipal: string;
  descricaoCnae: string;
  uf: string | null;
  municipio: string | null;
  porte: string | null;
  ativa: boolean;
  email: string | null;
  telefone: string | null;
  socios: readonly SocioOuAdmin[];
}
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `tests/enrichment/brasilapi.test.ts`. As respostas usadas aqui têm o
formato real, verificado contra a API em 2026-08-31.

```typescript
import { describe, it, expect } from "vitest";
import {
  buscarEmpresaPorCnpj,
  normalizarCnpj,
} from "../../src/enrichment/brasilapi.js";
import { respostaJson, respostaVazia, fetchFalso } from "../helpers/http-mock.js";

const RESPOSTA_REAL = {
  cnpj: "11222333000181",
  razao_social: "ALFA ALIMENTOS LTDA",
  nome_fantasia: "ALFA ALIMENTOS",
  cnae_fiscal: 1091101,
  cnae_fiscal_descricao: "Fabricação de produtos de panificação industrial",
  uf: "SC",
  municipio: "JOINVILLE",
  porte: "DEMAIS",
  descricao_situacao_cadastral: "ATIVA",
  email: "diretoria@alfa.com.br",
  ddd_telefone_1: "4733334444",
  qsa: [
    {
      nome_socio: "MARIA SOUZA",
      qualificacao_socio: "Administrador",
      data_entrada_sociedade: "2010-03-01",
    },
    {
      nome_socio: "JOAO LIMA",
      qualificacao_socio: "Sócio-Administrador",
      data_entrada_sociedade: "2010-03-01",
    },
  ],
};

describe("normalizarCnpj", () => {
  it("remove pontuação", () => {
    expect(normalizarCnpj("11.222.333/0001-81")).toBe("11222333000181");
  });

  it("aceita um CNPJ já limpo", () => {
    expect(normalizarCnpj("11222333000181")).toBe("11222333000181");
  });

  it("recusa algo que não tem 14 dígitos", () => {
    expect(() => normalizarCnpj("123")).toThrow(/14 dígitos/);
  });
});

describe("buscarEmpresaPorCnpj", () => {
  it("traduz a resposta da API para o vocabulário do domínio", async () => {
    const fake = fetchFalso([respostaJson(RESPOSTA_REAL)]);
    const empresa = await buscarEmpresaPorCnpj("11.222.333/0001-81", {
      fetch: fake,
    });

    expect(empresa).toEqual({
      cnpj: "11222333000181",
      razaoSocial: "ALFA ALIMENTOS LTDA",
      nomeFantasia: "ALFA ALIMENTOS",
      cnaePrincipal: "1091101",
      descricaoCnae: "Fabricação de produtos de panificação industrial",
      uf: "SC",
      municipio: "JOINVILLE",
      porte: "DEMAIS",
      ativa: true,
      email: "diretoria@alfa.com.br",
      telefone: "4733334444",
      socios: [
        { nome: "MARIA SOUZA", qualificacao: "Administrador" },
        { nome: "JOAO LIMA", qualificacao: "Sócio-Administrador" },
      ],
    });
  });

  it("chama a URL certa com o CNPJ limpo", async () => {
    const fake = fetchFalso([respostaJson(RESPOSTA_REAL)]);
    await buscarEmpresaPorCnpj("11.222.333/0001-81", { fetch: fake });
    expect(fake.chamadas[0]).toBe(
      "https://brasilapi.com.br/api/cnpj/v1/11222333000181",
    );
  });

  it("marca como inativa quando a situação não é ATIVA", async () => {
    const fake = fetchFalso([
      respostaJson({ ...RESPOSTA_REAL, descricao_situacao_cadastral: "BAIXADA" }),
    ]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa?.ativa).toBe(false);
  });

  it("devolve null quando o CNPJ não existe", async () => {
    const fake = fetchFalso([respostaJson({ message: "não encontrado" }, 404)]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa).toBeNull();
  });

  it("propaga erro de servidor em vez de fingir que a empresa não existe", async () => {
    const fake = fetchFalso([respostaVazia(500), respostaVazia(500)]);
    await expect(
      buscarEmpresaPorCnpj("11222333000181", { fetch: fake }),
    ).rejects.toThrow();
  });

  it("lida com resposta sem sócios e sem e-mail", async () => {
    const fake = fetchFalso([
      respostaJson({ ...RESPOSTA_REAL, qsa: [], email: null, nome_fantasia: null }),
    ]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa?.socios).toEqual([]);
    expect(empresa?.email).toBeNull();
    expect(empresa?.nomeFantasia).toBeNull();
  });

  it("lida com qsa ausente do payload", async () => {
    const semQsa = { ...RESPOSTA_REAL } as Record<string, unknown>;
    delete semQsa.qsa;
    const fake = fetchFalso([respostaJson(semQsa)]);
    const empresa = await buscarEmpresaPorCnpj("11222333000181", { fetch: fake });
    expect(empresa?.socios).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/enrichment/brasilapi.test.ts`
Esperado: FAIL — não consegue resolver `src/enrichment/brasilapi.js`.

- [ ] **Step 4: Implementar `src/enrichment/brasilapi.ts`**

```typescript
import { fetchJson, HttpError, type FetchLike } from "../http/fetch-json.js";
import type { DadosDaEmpresa, SocioOuAdmin } from "./types.js";

const BASE = "https://brasilapi.com.br/api/cnpj/v1";

/** Forma da resposta da BrasilAPI, verificada contra a API em 2026-08-31. */
interface RespostaBrasilApi {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string | null;
  cnae_fiscal: number;
  cnae_fiscal_descricao: string;
  uf: string | null;
  municipio: string | null;
  porte: string | null;
  descricao_situacao_cadastral: string;
  email: string | null;
  ddd_telefone_1: string | null;
  qsa?: Array<{
    nome_socio: string;
    qualificacao_socio: string;
    data_entrada_sociedade: string;
  }>;
}

export function normalizarCnpj(cnpj: string): string {
  const digitos = cnpj.replace(/\D/g, "");
  if (digitos.length !== 14) {
    throw new Error(`CNPJ precisa ter 14 dígitos, recebi "${cnpj}".`);
  }
  return digitos;
}

/**
 * Consulta os dados públicos do CNPJ. Grátis e sem autenticação.
 *
 * Devolve `null` só quando o CNPJ não existe (404). Erro de servidor é
 * propagado: tratar uma indisponibilidade da API como "empresa inexistente"
 * descartaria leads bons silenciosamente.
 */
export async function buscarEmpresaPorCnpj(
  cnpj: string,
  deps: { fetch?: FetchLike } = {},
): Promise<DadosDaEmpresa | null> {
  const limpo = normalizarCnpj(cnpj);

  let bruto: RespostaBrasilApi;
  try {
    bruto = await fetchJson<RespostaBrasilApi>(`${BASE}/${limpo}`, {
      fetch: deps.fetch,
      timeoutMs: 15_000,
      tentativas: 2,
    });
  } catch (erro) {
    if (erro instanceof HttpError && erro.status === 404) return null;
    throw erro;
  }

  const socios: SocioOuAdmin[] = (bruto.qsa ?? []).map((s) => ({
    nome: s.nome_socio,
    qualificacao: s.qualificacao_socio,
  }));

  return {
    cnpj: limpo,
    razaoSocial: bruto.razao_social,
    nomeFantasia: bruto.nome_fantasia,
    cnaePrincipal: String(bruto.cnae_fiscal),
    descricaoCnae: bruto.cnae_fiscal_descricao,
    uf: bruto.uf,
    municipio: bruto.municipio,
    porte: bruto.porte,
    ativa: bruto.descricao_situacao_cadastral === "ATIVA",
    email: bruto.email,
    telefone: bruto.ddd_telefone_1,
    socios,
  };
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/enrichment/brasilapi.test.ts`
Esperado: PASS (11 testes).

- [ ] **Step 6: Commit**

```bash
git add src/enrichment/types.ts src/enrichment/brasilapi.ts tests/enrichment/brasilapi.test.ts
git commit -m "feat(enrichment): adaptador BrasilAPI para dados públicos de CNPJ"
```

---

### Task 9: Adaptador Hunter.io

**Files:**
- Create: `src/enrichment/hunter.ts`
- Modify: `src/config/env.ts` (adicionar `HUNTER_API_KEY`)
- Modify: `.env.example`
- Modify: `tests/config/env.test.ts`
- Test: `tests/enrichment/hunter.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `FetchLike`, `HttpError`; `CandidatoDecisor`, `StatusVerificacao` de `src/enrichment/types.js`.
- Produces:
  - `acharEmailPorNome(input: { dominio: string; primeiroNome: string; sobrenome: string; apiKey: string }, deps?: { fetch?: FetchLike }): Promise<CandidatoDecisor | null>`
  - `buscarNoDominio(input: { dominio: string; departamento?: string; senioridade?: string; apiKey: string }, deps?: { fetch?: FetchLike }): Promise<CandidatoDecisor[]>`
  - `verificarEmail(input: { email: string; apiKey: string }, deps?: { fetch?: FetchLike }): Promise<{ status: StatusVerificacao; score: number }>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/enrichment/hunter.test.ts`. As respostas seguem o contrato oficial
da Hunter v2, verificado em 2026-08-31.

```typescript
import { describe, it, expect } from "vitest";
import {
  acharEmailPorNome,
  buscarNoDominio,
  verificarEmail,
} from "../../src/enrichment/hunter.js";
import { respostaJson, respostaVazia, fetchFalso } from "../helpers/http-mock.js";

const CHAVE = "chave-de-teste";

describe("acharEmailPorNome", () => {
  it("traduz a resposta do email-finder", async () => {
    const fake = fetchFalso([
      respostaJson({
        data: {
          email: "maria.souza@alfa.com.br",
          score: 94,
          position: "Diretora de Operações",
          verification: { status: "valid", date: "2026-08-30" },
        },
      }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "Maria", sobrenome: "Souza", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato).toEqual({
      nome: "Maria Souza",
      cargo: "Diretora de Operações",
      email: "maria.souza@alfa.com.br",
      confianca: 94,
      verificacao: "valid",
      fonte: "hunter_finder",
    });
  });

  it("monta a URL com os parâmetros certos", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { email: "a@b.com", score: 50, verification: { status: "unknown" } } }),
    ]);
    await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "Maria", sobrenome: "Souza", apiKey: CHAVE },
      { fetch: fake },
    );
    const url = fake.chamadas[0]!;
    expect(url).toContain("https://api.hunter.io/v2/email-finder");
    expect(url).toContain("domain=alfa.com.br");
    expect(url).toContain("first_name=Maria");
    expect(url).toContain("last_name=Souza");
    expect(url).toContain(`api_key=${CHAVE}`);
  });

  it("devolve null quando a Hunter não acha e-mail", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { email: null, score: 0, verification: { status: "unknown" } } }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "Maria", sobrenome: "Souza", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato).toBeNull();
  });

  it("mapeia um status desconhecido para 'unknown' em vez de vazar o termo da Hunter", async () => {
    const fake = fetchFalso([
      respostaJson({
        data: { email: "a@b.com", score: 40, verification: { status: "algo_novo" } },
      }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "b.com", primeiroNome: "A", sobrenome: "B", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato?.verificacao).toBe("unknown");
  });

  it("repete quando a Hunter responde 202 (ainda processando)", async () => {
    const fake = fetchFalso([
      respostaVazia(202),
      respostaJson({ data: { email: "a@b.com", score: 70, verification: { status: "valid" } } }),
    ]);
    const candidato = await acharEmailPorNome(
      { dominio: "b.com", primeiroNome: "A", sobrenome: "B", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidato?.email).toBe("a@b.com");
    expect(fake.chamadas.length).toBe(2);
  });
});

describe("buscarNoDominio", () => {
  it("traduz a lista de contatos", async () => {
    const fake = fetchFalso([
      respostaJson({
        data: {
          emails: [
            {
              value: "joao@alfa.com.br",
              confidence: 88,
              first_name: "João",
              last_name: "Lima",
              position: "Gerente de TI",
              department: "it",
              verification: { status: "valid" },
            },
            {
              value: "contato@alfa.com.br",
              confidence: 99,
              first_name: null,
              last_name: null,
              position: null,
              department: null,
              verification: { status: "valid" },
            },
          ],
        },
      }),
    ]);
    const candidatos = await buscarNoDominio(
      { dominio: "alfa.com.br", departamento: "it", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidatos).toHaveLength(2);
    expect(candidatos[0]).toEqual({
      nome: "João Lima",
      cargo: "Gerente de TI",
      email: "joao@alfa.com.br",
      confianca: 88,
      verificacao: "valid",
      fonte: "hunter_domain",
    });
    expect(candidatos[1]!.nome).toBeNull();
  });

  it("devolve lista vazia quando não há contatos", async () => {
    const fake = fetchFalso([respostaJson({ data: { emails: [] } })]);
    const candidatos = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(candidatos).toEqual([]);
  });

  it("passa os filtros de departamento e senioridade", async () => {
    const fake = fetchFalso([respostaJson({ data: { emails: [] } })]);
    await buscarNoDominio(
      { dominio: "alfa.com.br", departamento: "it", senioridade: "executive", apiKey: CHAVE },
      { fetch: fake },
    );
    expect(fake.chamadas[0]).toContain("department=it");
    expect(fake.chamadas[0]).toContain("seniority=executive");
  });
});

describe("verificarEmail", () => {
  it("devolve status e score", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { status: "valid", score: 97 } }),
    ]);
    const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
    expect(r).toEqual({ status: "valid", score: 97 });
  });

  it("mapeia webmail e disposable para invalid, que não servem para prospecção B2B", async () => {
    for (const bruto of ["webmail", "disposable"]) {
      const fake = fetchFalso([respostaJson({ data: { status: bruto, score: 10 } })]);
      const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
      expect(r.status, bruto).toBe("invalid");
    }
  });

  it("preserva accept_all, que não é nem válido nem inválido", async () => {
    const fake = fetchFalso([
      respostaJson({ data: { status: "accept_all", score: 55 } }),
    ]);
    const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
    expect(r.status).toBe("accept_all");
  });

  it("repete no 222, que é timeout de SMTP", async () => {
    const fake = fetchFalso([
      respostaVazia(222),
      respostaJson({ data: { status: "valid", score: 90 } }),
    ]);
    const r = await verificarEmail({ email: "a@b.com", apiKey: CHAVE }, { fetch: fake });
    expect(r.status).toBe("valid");
    expect(fake.chamadas.length).toBe(2);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/enrichment/hunter.test.ts`
Esperado: FAIL — não consegue resolver `src/enrichment/hunter.js`.

- [ ] **Step 3: Implementar `src/enrichment/hunter.ts`**

```typescript
import { fetchJson, type FetchLike } from "../http/fetch-json.js";
import type { CandidatoDecisor, StatusVerificacao } from "./types.js";

const BASE = "https://api.hunter.io/v2";

/** 202 = processando, 222 = timeout de SMTP. Ambos pedem nova tentativa. */
const STATUS_PARA_REPETIR = [202, 222];

/**
 * Traduz o vocabulário da Hunter para o nosso.
 *
 * `webmail` e `disposable` viram `invalid`: um Gmail pessoal ou um endereço
 * descartável tecnicamente entrega, mas não é o decisor numa empresa — tratar
 * como válido encheria o funil de contatos inúteis.
 */
function traduzirStatus(bruto: unknown): StatusVerificacao {
  switch (bruto) {
    case "valid":
      return "valid";
    case "accept_all":
      return "accept_all";
    case "invalid":
    case "webmail":
    case "disposable":
      return "invalid";
    default:
      return "unknown";
  }
}

function juntarNome(
  primeiro: string | null | undefined,
  ultimo: string | null | undefined,
): string | null {
  const partes = [primeiro, ultimo].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return partes.length ? partes.join(" ") : null;
}

interface RespostaFinder {
  data: {
    email: string | null;
    score: number;
    position?: string | null;
    verification?: { status?: string };
  };
}

export async function acharEmailPorNome(
  input: {
    dominio: string;
    primeiroNome: string;
    sobrenome: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor | null> {
  const parametros = new URLSearchParams({
    domain: input.dominio,
    first_name: input.primeiroNome,
    last_name: input.sobrenome,
    api_key: input.apiKey,
  });

  const resposta = await fetchJson<RespostaFinder>(
    `${BASE}/email-finder?${parametros}`,
    { fetch: deps.fetch, tentativas: 3, statusParaRepetir: STATUS_PARA_REPETIR },
  );

  if (!resposta.data.email) return null;

  return {
    nome: juntarNome(input.primeiroNome, input.sobrenome),
    cargo: resposta.data.position ?? null,
    email: resposta.data.email,
    confianca: resposta.data.score,
    verificacao: traduzirStatus(resposta.data.verification?.status),
    fonte: "hunter_finder",
  };
}

interface RespostaDominio {
  data: {
    emails: Array<{
      value: string;
      confidence: number;
      first_name: string | null;
      last_name: string | null;
      position: string | null;
      department: string | null;
      verification?: { status?: string };
    }>;
  };
}

export async function buscarNoDominio(
  input: {
    dominio: string;
    departamento?: string;
    senioridade?: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor[]> {
  const parametros = new URLSearchParams({
    domain: input.dominio,
    limit: "10",
    api_key: input.apiKey,
  });
  if (input.departamento) parametros.set("department", input.departamento);
  if (input.senioridade) parametros.set("seniority", input.senioridade);

  const resposta = await fetchJson<RespostaDominio>(
    `${BASE}/domain-search?${parametros}`,
    { fetch: deps.fetch, tentativas: 3, statusParaRepetir: STATUS_PARA_REPETIR },
  );

  return resposta.data.emails.map((e) => ({
    nome: juntarNome(e.first_name, e.last_name),
    cargo: e.position,
    email: e.value,
    confianca: e.confidence,
    verificacao: traduzirStatus(e.verification?.status),
    fonte: "hunter_domain" as const,
  }));
}

interface RespostaVerificador {
  data: { status: string; score: number };
}

export async function verificarEmail(
  input: { email: string; apiKey: string },
  deps: { fetch?: FetchLike } = {},
): Promise<{ status: StatusVerificacao; score: number }> {
  const parametros = new URLSearchParams({
    email: input.email,
    api_key: input.apiKey,
  });

  const resposta = await fetchJson<RespostaVerificador>(
    `${BASE}/email-verifier?${parametros}`,
    { fetch: deps.fetch, tentativas: 3, statusParaRepetir: STATUS_PARA_REPETIR },
  );

  return {
    status: traduzirStatus(resposta.data.status),
    score: resposta.data.score,
  };
}
```

- [ ] **Step 4: Adicionar a chave ao ambiente**

Em `src/config/env.ts`, acrescente ao `EnvSchema`:

```typescript
  HUNTER_API_KEY: z.string().min(1),
```

Em `.env.example`:

```
HUNTER_API_KEY=sua-chave-hunter
```

Em `tests/config/env.test.ts`, acrescente `HUNTER_API_KEY: "chave"` ao objeto
`validSource`.

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/enrichment/hunter.test.ts tests/config/env.test.ts`
Esperado: PASS (12 + 3 testes).

- [ ] **Step 6: Commit**

```bash
git add src/enrichment/hunter.ts src/config/env.ts .env.example tests/enrichment/hunter.test.ts tests/config/env.test.ts
git commit -m "feat(enrichment): adaptador Hunter.io com tradução de status"
```

---

### Task 10: A cadeia de enriquecimento

Junta tudo: grátis primeiro, paga depois, e registra qual fonte acertou — a
única forma de descobrir a taxa de acerto real no Brasil, já que nenhum
fornecedor publica esse número.

**Files:**
- Create: `src/enrichment/chain.ts`
- Test: `tests/enrichment/chain.test.ts`

**Interfaces:**
- Consumes: `buscarEmpresaPorCnpj`, `acharEmailPorNome`, `buscarNoDominio`, `verificarEmail`, `ehEmailGenerico`, `CandidatoDecisor`, `DadosDaEmpresa`, `FetchLike`.
- Produces:
  - `type AlvoDaCampanha = { tipo: "socio_ou_dono" } | { tipo: "cargo_funcional"; departamento: string; senioridade?: string }`
  - `type ResultadoEnriquecimento = { achou: true; candidato: CandidatoDecisor; tentativas: readonly TentativaDeFonte[] } | { achou: false; motivo: string; tentativas: readonly TentativaDeFonte[] }`
  - `type TentativaDeFonte = { fonte: FonteDoDecisor; resultado: "acertou" | "vazio" | "generico" | "nao_verificado" | "erro"; detalhe?: string }`
  - `enriquecerDecisor(input: EntradaEnriquecimento, deps?: DepsEnriquecimento): Promise<ResultadoEnriquecimento>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/enrichment/chain.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  enriquecerDecisor,
  type DepsEnriquecimento,
} from "../../src/enrichment/chain.js";
import type { DadosDaEmpresa } from "../../src/enrichment/types.js";

const EMPRESA: DadosDaEmpresa = {
  cnpj: "11222333000181",
  razaoSocial: "ALFA ALIMENTOS LTDA",
  nomeFantasia: "ALFA ALIMENTOS",
  cnaePrincipal: "1091101",
  descricaoCnae: "Panificação industrial",
  uf: "SC",
  municipio: "JOINVILLE",
  porte: "DEMAIS",
  ativa: true,
  email: null,
  telefone: "4733334444",
  socios: [{ nome: "MARIA SOUZA", qualificacao: "Administrador" }],
};

function deps(overrides: Partial<DepsEnriquecimento> = {}): DepsEnriquecimento {
  return {
    buscarEmpresa: vi.fn().mockResolvedValue(EMPRESA),
    acharPorNome: vi.fn().mockResolvedValue(null),
    buscarDominio: vi.fn().mockResolvedValue([]),
    verificar: vi.fn().mockResolvedValue({ status: "valid", score: 90 }),
    ...overrides,
  };
}

const ENTRADA = {
  cnpj: "11222333000181",
  dominio: "alfa.com.br",
  apiKey: "chave",
  alvo: { tipo: "socio_ou_dono" } as const,
};

describe("enriquecerDecisor — caminho grátis", () => {
  it("usa o e-mail do registro da Receita quando ele é de pessoa", async () => {
    const d = deps({
      buscarEmpresa: vi
        .fn()
        .mockResolvedValue({ ...EMPRESA, email: "maria.souza@alfa.com.br" }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.achou).toBe(true);
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.email).toBe("maria.souza@alfa.com.br");
    expect(r.candidato.fonte).toBe("cnpj_email");
    expect(d.acharPorNome).not.toHaveBeenCalled();
  });

  it("rejeita o e-mail da Receita quando é caixa genérica e segue a cadeia", async () => {
    const d = deps({
      buscarEmpresa: vi
        .fn()
        .mockResolvedValue({ ...EMPRESA, email: "contato@alfa.com.br" }),
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: "Administradora",
        email: "maria@alfa.com.br",
        confianca: 90,
        verificacao: "valid",
        fonte: "hunter_finder",
      }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.achou).toBe(true);
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.fonte).toBe("hunter_finder");
    expect(r.tentativas.map((t) => t.resultado)).toContain("generico");
  });
});

describe("enriquecerDecisor — caminho pago", () => {
  it("usa o nome do sócio para chamar o email-finder, em vez de buscar às cegas", async () => {
    const acharPorNome = vi.fn().mockResolvedValue({
      nome: "Maria Souza",
      cargo: null,
      email: "maria.souza@alfa.com.br",
      confianca: 88,
      verificacao: "valid",
      fonte: "hunter_finder",
    });
    const d = deps({ acharPorNome });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(acharPorNome).toHaveBeenCalledWith(
      expect.objectContaining({
        dominio: "alfa.com.br",
        primeiroNome: "MARIA",
        sobrenome: "SOUZA",
      }),
    );
    expect(r.achou).toBe(true);
  });

  it("cai para a busca por domínio quando o cargo-alvo é funcional", async () => {
    const buscarDominio = vi.fn().mockResolvedValue([
      {
        nome: "João Lima",
        cargo: "Gerente de TI",
        email: "joao@alfa.com.br",
        confianca: 85,
        verificacao: "valid",
        fonte: "hunter_domain",
      },
    ]);
    const d = deps({ buscarDominio });
    const r = await enriquecerDecisor(
      { ...ENTRADA, alvo: { tipo: "cargo_funcional", departamento: "it" } },
      d,
    );

    expect(buscarDominio).toHaveBeenCalledWith(
      expect.objectContaining({ dominio: "alfa.com.br", departamento: "it" }),
    );
    expect(r.achou).toBe(true);
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.fonte).toBe("hunter_domain");
  });

  it("descarta candidatos genéricos vindos da busca por domínio", async () => {
    const buscarDominio = vi.fn().mockResolvedValue([
      {
        nome: null,
        cargo: null,
        email: "contato@alfa.com.br",
        confianca: 99,
        verificacao: "valid",
        fonte: "hunter_domain",
      },
    ]);
    const d = deps({ buscarDominio });
    const r = await enriquecerDecisor(
      { ...ENTRADA, alvo: { tipo: "cargo_funcional", departamento: "it" } },
      d,
    );

    expect(r.achou).toBe(false);
    expect(r.tentativas.some((t) => t.resultado === "generico")).toBe(true);
  });

  it("escolhe o candidato de maior confiança quando há vários", async () => {
    const buscarDominio = vi.fn().mockResolvedValue([
      { nome: "A", cargo: null, email: "a@alfa.com.br", confianca: 60, verificacao: "valid", fonte: "hunter_domain" },
      { nome: "B", cargo: null, email: "b@alfa.com.br", confianca: 92, verificacao: "valid", fonte: "hunter_domain" },
    ]);
    const d = deps({ buscarDominio });
    const r = await enriquecerDecisor(
      { ...ENTRADA, alvo: { tipo: "cargo_funcional", departamento: "it" } },
      d,
    );
    if (!r.achou) throw new Error("esperava sucesso");
    expect(r.candidato.email).toBe("b@alfa.com.br");
  });
});

describe("enriquecerDecisor — recusas", () => {
  it("recusa empresa inativa antes de gastar qualquer crédito", async () => {
    const d = deps({
      buscarEmpresa: vi.fn().mockResolvedValue({ ...EMPRESA, ativa: false }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.achou).toBe(false);
    if (r.achou) throw new Error("esperava falha");
    expect(r.motivo).toMatch(/inativa/i);
    expect(d.acharPorNome).not.toHaveBeenCalled();
    expect(d.buscarDominio).not.toHaveBeenCalled();
  });

  it("recusa quando o CNPJ não existe", async () => {
    const d = deps({ buscarEmpresa: vi.fn().mockResolvedValue(null) });
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(false);
    if (r.achou) throw new Error("esperava falha");
    expect(r.motivo).toMatch(/não encontrada/i);
  });

  it("recusa um e-mail que a verificação reprovou", async () => {
    const d = deps({
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria@alfa.com.br",
        confianca: 80,
        verificacao: "invalid",
        fonte: "hunter_finder",
      }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(false);
    expect(r.tentativas.some((t) => t.resultado === "nao_verificado")).toBe(true);
  });

  it("aceita accept_all, que é indeterminado e não reprovado", async () => {
    const d = deps({
      acharPorNome: vi.fn().mockResolvedValue({
        nome: "Maria Souza",
        cargo: null,
        email: "maria@alfa.com.br",
        confianca: 80,
        verificacao: "accept_all",
        fonte: "hunter_finder",
      }),
    });
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(true);
  });

  it("registra a falha da fonte e continua, em vez de derrubar a cadeia", async () => {
    const d = deps({
      acharPorNome: vi.fn().mockRejectedValue(new Error("Hunter fora do ar")),
      buscarDominio: vi.fn().mockResolvedValue([
        { nome: "C", cargo: null, email: "c@alfa.com.br", confianca: 70, verificacao: "valid", fonte: "hunter_domain" },
      ]),
    });
    const r = await enriquecerDecisor(ENTRADA, d);

    expect(r.tentativas.some((t) => t.resultado === "erro")).toBe(true);
    expect(r.achou).toBe(true);
  });

  it("devolve todas as tentativas mesmo quando nada é achado", async () => {
    const d = deps();
    const r = await enriquecerDecisor(ENTRADA, d);
    expect(r.achou).toBe(false);
    expect(r.tentativas.length).toBeGreaterThan(0);
    for (const t of r.tentativas) {
      expect(t).toHaveProperty("fonte");
      expect(t).toHaveProperty("resultado");
    }
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/enrichment/chain.test.ts`
Esperado: FAIL — não consegue resolver `src/enrichment/chain.js`.

- [ ] **Step 3: Implementar `src/enrichment/chain.ts`**

```typescript
import { buscarEmpresaPorCnpj } from "./brasilapi.js";
import { acharEmailPorNome, buscarNoDominio, verificarEmail } from "./hunter.js";
import { ehEmailGenerico } from "./generic-emails.js";
import type {
  CandidatoDecisor,
  DadosDaEmpresa,
  FonteDoDecisor,
  StatusVerificacao,
} from "./types.js";

/**
 * Quem estamos procurando. A escolha muda a cadeia inteira: o quadro societário
 * do CNPJ entrega sócios e administradores de graça, o que resolve o caso da
 * PME — mas não serve para achar um "Gerente de TI" numa empresa de 500
 * pessoas, onde só a busca por domínio funciona.
 */
export type AlvoDaCampanha =
  | { tipo: "socio_ou_dono" }
  | { tipo: "cargo_funcional"; departamento: string; senioridade?: string };

export interface TentativaDeFonte {
  fonte: FonteDoDecisor;
  resultado: "acertou" | "vazio" | "generico" | "nao_verificado" | "erro";
  detalhe?: string;
}

export type ResultadoEnriquecimento =
  | { achou: true; candidato: CandidatoDecisor; tentativas: readonly TentativaDeFonte[] }
  | { achou: false; motivo: string; tentativas: readonly TentativaDeFonte[] };

export interface EntradaEnriquecimento {
  cnpj: string;
  dominio: string | null;
  apiKey: string;
  alvo: AlvoDaCampanha;
}

export interface DepsEnriquecimento {
  buscarEmpresa: typeof buscarEmpresaPorCnpj;
  acharPorNome: typeof acharEmailPorNome;
  buscarDominio: typeof buscarNoDominio;
  verificar: typeof verificarEmail;
}

const DEPS_PADRAO: DepsEnriquecimento = {
  buscarEmpresa: buscarEmpresaPorCnpj,
  acharPorNome: acharEmailPorNome,
  buscarDominio: buscarNoDominio,
  verificar: verificarEmail,
};

/** `accept_all` é indeterminado, não reprovado — o domínio aceita tudo. */
function verificacaoAprova(status: StatusVerificacao): boolean {
  return status === "valid" || status === "accept_all";
}

function separarNome(completo: string): { primeiro: string; ultimo: string } | null {
  const partes = completo.trim().split(/\s+/).filter(Boolean);
  if (partes.length < 2) return null;
  return { primeiro: partes[0]!, ultimo: partes[partes.length - 1]! };
}

/**
 * Procura o decisor de uma empresa, das fontes gratuitas para as pagas.
 *
 * Devolve sempre a lista de tentativas, com o que cada fonte respondeu. Isso é
 * deliberado: nenhum fornecedor publica taxa de acerto para o Brasil, então a
 * única forma de saber se a Hunter vale o custo aqui é medir. Quem chama deve
 * gravar `tentativas` em `events`.
 */
export async function enriquecerDecisor(
  entrada: EntradaEnriquecimento,
  deps: DepsEnriquecimento = DEPS_PADRAO,
): Promise<ResultadoEnriquecimento> {
  const tentativas: TentativaDeFonte[] = [];

  let empresa: DadosDaEmpresa | null;
  try {
    empresa = await deps.buscarEmpresa(entrada.cnpj);
  } catch (erro) {
    tentativas.push({
      fonte: "cnpj_qsa",
      resultado: "erro",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return { achou: false, motivo: "Falha ao consultar o CNPJ.", tentativas };
  }

  if (!empresa) {
    tentativas.push({ fonte: "cnpj_qsa", resultado: "vazio" });
    return { achou: false, motivo: "Empresa não encontrada pelo CNPJ.", tentativas };
  }

  // Empresa baixada, suspensa ou inapta não recebe prospecção — e checar isso
  // antes de qualquer chamada paga evita queimar crédito à toa.
  if (!empresa.ativa) {
    tentativas.push({ fonte: "cnpj_qsa", resultado: "vazio", detalhe: "situação cadastral não é ATIVA" });
    return { achou: false, motivo: "Empresa com situação cadastral inativa.", tentativas };
  }

  // 1. E-mail do próprio registro da Receita, se for de pessoa.
  if (empresa.email) {
    if (ehEmailGenerico(empresa.email)) {
      tentativas.push({ fonte: "cnpj_email", resultado: "generico", detalhe: empresa.email });
    } else {
      const candidato: CandidatoDecisor = {
        nome: empresa.socios[0]?.nome ?? null,
        cargo: empresa.socios[0]?.qualificacao ?? null,
        email: empresa.email,
        // Sintético: a Receita não dá score. 70 reflete "endereço declarado
        // pela própria empresa, mas pode estar desatualizado".
        confianca: 70,
        verificacao: "unknown",
        fonte: "cnpj_email",
      };
      const aprovado = await verificarComTolerancia(candidato, entrada.apiKey, deps, tentativas);
      if (aprovado) return { achou: true, candidato: aprovado, tentativas };
    }
  }

  const semDominio = !entrada.dominio;
  if (semDominio) {
    tentativas.push({ fonte: "hunter_finder", resultado: "vazio", detalhe: "empresa sem site conhecido" });
    return { achou: false, motivo: "Sem domínio para procurar o e-mail do decisor.", tentativas };
  }
  const dominio = entrada.dominio!;

  // 2. Nome do sócio (grátis) + email-finder (pago) — acerta muito mais que a
  //    busca cega por domínio, pelo mesmo crédito.
  if (entrada.alvo.tipo === "socio_ou_dono") {
    for (const socio of empresa.socios) {
      const nome = separarNome(socio.nome);
      if (!nome) continue;
      try {
        const achado = await deps.acharPorNome({
          dominio,
          primeiroNome: nome.primeiro,
          sobrenome: nome.ultimo,
          apiKey: entrada.apiKey,
        });
        if (!achado?.email) {
          tentativas.push({ fonte: "hunter_finder", resultado: "vazio", detalhe: socio.nome });
          continue;
        }
        if (ehEmailGenerico(achado.email)) {
          tentativas.push({ fonte: "hunter_finder", resultado: "generico", detalhe: achado.email });
          continue;
        }
        const comCargo: CandidatoDecisor = {
          ...achado,
          cargo: achado.cargo ?? socio.qualificacao,
        };
        const aprovado = await verificarComTolerancia(comCargo, entrada.apiKey, deps, tentativas);
        if (aprovado) return { achou: true, candidato: aprovado, tentativas };
      } catch (erro) {
        tentativas.push({
          fonte: "hunter_finder",
          resultado: "erro",
          detalhe: erro instanceof Error ? erro.message : String(erro),
        });
      }
    }
  }

  // 3. Busca por domínio filtrada por cargo. Único caminho quando o alvo é
  //    funcional, e último recurso quando o sócio não deu em nada.
  try {
    const encontrados = await deps.buscarDominio({
      dominio,
      departamento:
        entrada.alvo.tipo === "cargo_funcional" ? entrada.alvo.departamento : undefined,
      senioridade:
        entrada.alvo.tipo === "cargo_funcional" ? entrada.alvo.senioridade : undefined,
      apiKey: entrada.apiKey,
    });

    const pessoais = encontrados.filter((c) => c.email && !ehEmailGenerico(c.email));
    const descartados = encontrados.length - pessoais.length;
    if (descartados > 0) {
      tentativas.push({
        fonte: "hunter_domain",
        resultado: "generico",
        detalhe: `${descartados} caixa(s) compartilhada(s) descartada(s)`,
      });
    }

    if (pessoais.length === 0) {
      if (encontrados.length === 0) {
        tentativas.push({ fonte: "hunter_domain", resultado: "vazio" });
      }
    } else {
      const melhor = [...pessoais].sort((a, b) => b.confianca - a.confianca)[0]!;
      const aprovado = await verificarComTolerancia(melhor, entrada.apiKey, deps, tentativas);
      if (aprovado) return { achou: true, candidato: aprovado, tentativas };
    }
  } catch (erro) {
    tentativas.push({
      fonte: "hunter_domain",
      resultado: "erro",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
  }

  return { achou: false, motivo: "Nenhum decisor com e-mail utilizável.", tentativas };
}

/**
 * Verifica o e-mail antes de aceitar o candidato. Uma falha da verificação não
 * derruba a cadeia: registra e recusa aquele candidato, deixando a próxima
 * fonte tentar.
 */
async function verificarComTolerancia(
  candidato: CandidatoDecisor,
  apiKey: string,
  deps: DepsEnriquecimento,
  tentativas: TentativaDeFonte[],
): Promise<CandidatoDecisor | null> {
  if (!candidato.email) return null;

  let status: StatusVerificacao;
  try {
    const r = await deps.verificar({ email: candidato.email, apiKey });
    status = r.status;
  } catch (erro) {
    tentativas.push({
      fonte: candidato.fonte,
      resultado: "erro",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }

  if (!verificacaoAprova(status)) {
    tentativas.push({
      fonte: candidato.fonte,
      resultado: "nao_verificado",
      detalhe: `verificação devolveu ${status}`,
    });
    return null;
  }

  tentativas.push({ fonte: candidato.fonte, resultado: "acertou" });
  return { ...candidato, verificacao: status };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/enrichment/chain.test.ts`
Esperado: PASS (12 testes).

- [ ] **Step 5: Rodar a suíte inteira e o typecheck**

Run: `npm test && npm run typecheck`
Esperado: tudo verde.

- [ ] **Step 6: Commit**

```bash
git add src/enrichment/chain.ts tests/enrichment/chain.test.ts
git commit -m "feat(enrichment): cadeia grátis-antes-de-pago com medição de acerto por fonte"
```

---

## Cobertura do spec por este plano

| Requisito | Onde é atendido |
|---|---|
| Persistência das 7 tabelas (§3.2) | Tasks 1, 3, 4, 5, 6 |
| Dedup global de CNPJ (Fluxo 1, item 4) | Task 4 |
| Enriquecimento com fontes grátis antes das pagas (Fluxo 2, item 1) | Task 10 |
| Verificação do e-mail antes de enfileirar (Fluxo 2, item 2) | Tasks 9, 10 |
| Descarte com motivo quando não há decisor (Fluxo 2, item 3) | Task 10 |
| Idempotência do webhook de resposta (Emenda do review) | Task 6 |
| Lista de supressão persistida (§3.2, §5) | Task 6 |
| Auditoria em `events` (§5) | Task 6 |
| RLS e constraints do schema realmente verificados (Emenda 5) | Task 1 |

**Fora deste plano, por design:** descoberta de empresas por filtro, envio via
Instantly, webhooks de Cal.com, rotas HTTP, disjuntor de bounce, painel e
fluxos n8n.

### Provedor de descoberta — decidido, para o próximo plano

A pesquisa de provedores fechou enquanto este plano era escrito. Registrando a
decisão aqui para que o Plano 3 não precise refazê-la:

**Casa dos Dados** é o provedor de busca. `POST https://api.casadosdados.com.br/v5/cnpj/pesquisa`,
autenticação por header `api-key`. Filtros verificados: `codigo_atividade_principal`,
`codigo_atividade_secundaria`, `uf`, `municipio`, `situacao_cadastral`,
`porte_empresa.codigos`, `busca_textual`, `limite`, `pagina`. Resposta:
`{ total, cnpjs: [{ cnpj, razao_social, nome_fantasia, situacao_cadastral, endereco, quadro_societario }] }`.
Preço: R$ 0,01 por CNPJ, sem mensalidade.

**Por que não o CNPJá**, apesar de a pesquisa tê-lo recomendado primeiro: o
endpoint de busca existe, mas o esquema exato de parâmetros não pôde ser
verificado — a página de referência não renderizou. Escrever código contra
nomes de campo inventados é pior do que admitir a lacuna. Se o CNPJá vier a ser
avaliado, peça o OpenAPI direto ao fornecedor antes.

**BrasilAPI e ReceitaWS estão fora** para busca: ambos fazem apenas consulta de
um CNPJ por vez, o que a Task 8 deste plano já cobre para o enriquecimento.

Note que `porte_empresa` traz as classes da Receita (ME, EPP, DEMAIS), não
número de funcionários. Um filtro de nicho do tipo "50+ funcionários" não tem
correspondente direto e precisará ser aproximado — ou por porte, ou por capital
social.

## Riscos que este plano assume

- **A cobertura da Hunter no Brasil é desconhecida.** Nenhum fornecedor publica
  o número. A Task 10 existe em boa parte para medi-lo: `tentativas` grava o
  que cada fonte respondeu, e depois de algumas centenas de empresas haverá
  dados reais para decidir se a Hunter se paga ou se é preciso um provedor
  brasileiro.
- **A BrasilAPI é gratuita e mantida pela comunidade.** Não há SLA. Se o volume
  crescer, avaliar um provedor pago de CNPJ ou hospedar o dump público da
  Receita.
- **`qsa` traz sócio, não gerente.** Campanhas cujo alvo é um cargo funcional
  dependem inteiramente da busca por domínio da Hunter — que é justamente o
  caminho de menor cobertura. Esperar taxa de acerto mais baixa nesse caso.
