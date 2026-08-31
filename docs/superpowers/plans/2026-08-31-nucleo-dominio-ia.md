# Plano 1 — Núcleo: Schema, Domínio e IA

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a fundação testável da plataforma de prospecção — schema do banco, máquina de estágios do funil, regras de supressão, política de resposta e os quatro módulos de IA (interpretar nicho, escrever e-mail, classificar resposta, redigir réplica).

**Architecture:** Pacote TypeScript único, sem framework web nesta fase. Toda a lógica de negócio vive em módulos puros e testáveis; os módulos de IA recebem o cliente Anthropic por injeção de dependência, então os testes rodam sem chamar a API. As integrações externas (Casa dos Dados, Hunter, Instantly), as rotas HTTP e o painel são os Planos 2 e 3 — este plano entrega as peças que eles consomem.

**Tech Stack:** TypeScript (ESM), Node 24, Vitest, Zod, `@anthropic-ai/sdk`, `@supabase/supabase-js`, Postgres (Supabase).

## Global Constraints

- Modelo Claude: **`claude-opus-5`** em todas as chamadas. Nunca use outro ID de modelo.
- Nunca use `budget_tokens` (retorna 400 no Opus 5). Thinking é adaptativo por padrão — não passe `thinking: {type: "disabled"}`. Controle custo com `output_config.effort`.
- Saída estruturada sempre via `client.messages.parse()` + `zodOutputFormat(schema)` dentro de `output_config.format`. Nunca use o parâmetro `output_format` (obsoleto), nunca peça JSON em texto livre.
- Toda tabela do banco tem coluna `tenant_id` — requisito para a evolução multi-cliente prevista no spec.
- Todo texto gerado para o lead é em **português brasileiro**.
- Módulos de IA recebem dependências por parâmetro com default (`deps: AiDeps = { client: getClient() }`) para permitir teste sem rede.
- ESM: sempre importe com extensão `.js` nos caminhos relativos (`./client.js`), nunca use `__dirname`.
- Idioma de commits, comentários e mensagens de erro: português brasileiro.

**Referência:** `docs/superpowers/specs/2026-08-28-prospeccao-b2b-ia-design.md`

---

### Task 1: Scaffold do projeto e validação de ambiente

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config/env.ts`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: `loadEnv(source: Record<string, string | undefined>): Env` e o acessor memoizado `env(): Env`, onde
  `Env = { ANTHROPIC_API_KEY: string; SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }`.
  As tasks seguintes consomem chamando `env()`, nunca `env` direto.

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "prospeccao",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.122.0",
    "@supabase/supabase-js": "^2.45.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Criar `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Criar `.gitignore`**

```
node_modules/
.env
.env.local
dist/
coverage/
```

- [ ] **Step 5: Criar `.env.example`**

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

- [ ] **Step 6: Instalar dependências**

Run: `npm install`
Esperado: instala sem erro, cria `package-lock.json`.

- [ ] **Step 7: Escrever o teste que falha**

Criar `tests/config/env.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const validSource = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "chave-de-servico",
};

describe("loadEnv", () => {
  it("retorna as variáveis quando todas estão presentes", () => {
    expect(loadEnv(validSource)).toEqual(validSource);
  });

  it("lança erro nomeando a variável ausente", () => {
    const { SUPABASE_URL, ...semUrl } = validSource;
    expect(() => loadEnv(semUrl)).toThrow(/SUPABASE_URL/);
  });

  it("lança erro quando uma variável está vazia", () => {
    expect(() => loadEnv({ ...validSource, ANTHROPIC_API_KEY: "" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
```

- [ ] **Step 8: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/config/env.test.ts`
Esperado: FAIL — não consegue resolver `src/config/env.js`.

- [ ] **Step 9: Implementar `src/config/env.ts`**

```typescript
import { z } from "zod";

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  const resultado = EnvSchema.safeParse(source);
  if (!resultado.success) {
    const faltando = resultado.error.issues
      .map((problema) => problema.path.join("."))
      .join(", ");
    throw new Error(`Variáveis de ambiente inválidas ou ausentes: ${faltando}`);
  }
  return resultado.data;
}

let cache: Env | null = null;

/** Lê e valida o ambiente do processo na primeira chamada. */
export function env(): Env {
  if (!cache) cache = loadEnv(process.env);
  return cache;
}
```

- [ ] **Step 10: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/config/env.test.ts`
Esperado: PASS (3 testes).

- [ ] **Step 11: Rodar o typecheck**

Run: `npm run typecheck`
Esperado: sem erros.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config/env.ts tests/config/env.test.ts
git commit -m "feat: scaffold do projeto e validação de variáveis de ambiente"
```

---

### Task 2: Schema do banco e tipos de domínio

**Files:**
- Create: `supabase/migrations/0001_initial_schema.sql`
- Create: `src/db/types.ts`
- Create: `src/db/client.ts`
- Test: `tests/db/types.test.ts`

**Interfaces:**
- Consumes: `env()` da Task 1.
- Produces:
  - `LEAD_STAGES: readonly LeadStage[]` e o tipo `LeadStage = "discovered" | "enriched" | "contacted" | "in_conversation" | "meeting_booked" | "discarded" | "error"`.
  - `REPLY_INTENTS: readonly ReplyIntent[]` e o tipo `ReplyIntent = "interested" | "question_or_objection" | "not_now" | "no" | "opt_out" | "out_of_scope"`.
  - Interfaces `Campaign`, `Company`, `Lead`, `Message`, `SuppressionEntry`.
  - `getSupabase(): SupabaseClient`.

- [ ] **Step 1: Criar a migration `supabase/migrations/0001_initial_schema.sql`**

```sql
create extension if not exists "pgcrypto";

create type lead_stage as enum (
  'discovered', 'enriched', 'contacted', 'in_conversation',
  'meeting_booked', 'discarded', 'error'
);

create type reply_intent as enum (
  'interested', 'question_or_objection', 'not_now', 'no', 'opt_out', 'out_of_scope'
);

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  niche_description text not null,
  filters jsonb,
  offer_description text not null,
  tone text not null default 'consultivo, direto, sem jargão',
  scheduling_link text not null,
  daily_send_limit int not null default 20,
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now()
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  cnpj text,
  legal_name text not null,
  trade_name text,
  website text,
  city text,
  uf text,
  employee_count int,
  summary text,
  source text not null,
  enrichment_status text not null default 'pending'
    check (enrichment_status in ('pending', 'enriched', 'failed')),
  created_at timestamptz not null default now()
);
create unique index companies_tenant_cnpj_uniq
  on companies (tenant_id, cnpj) where cnpj is not null;
create index companies_enrichment_idx
  on companies (tenant_id, enrichment_status);

create table leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  full_name text,
  role_title text,
  email text not null,
  email_verified boolean not null default false,
  stage lead_stage not null default 'enriched',
  discard_reason text,
  exchange_count int not null default 0,
  resume_at timestamptz,
  needs_human boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index leads_tenant_email_uniq on leads (tenant_id, lower(email));
create index leads_stage_idx on leads (tenant_id, stage);

create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  direction text not null check (direction in ('outbound', 'inbound')),
  subject text,
  body text not null,
  intent reply_intent,
  confidence numeric,
  ai_reasoning text,
  external_id text,
  created_at timestamptz not null default now()
);
create index messages_lead_idx on messages (lead_id, created_at);

create table suppression_list (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  value text not null,
  kind text not null check (kind in ('email', 'domain')),
  reason text,
  created_at timestamptz not null default now()
);
create unique index suppression_uniq on suppression_list (tenant_id, kind, value);

create table events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  lead_id uuid,
  kind text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index events_created_idx on events (created_at desc);
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `tests/db/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { LEAD_STAGES, REPLY_INTENTS } from "../../src/db/types.js";

describe("constantes de domínio", () => {
  it("expõe exatamente os sete estágios do funil", () => {
    expect(LEAD_STAGES).toEqual([
      "discovered",
      "enriched",
      "contacted",
      "in_conversation",
      "meeting_booked",
      "discarded",
      "error",
    ]);
  });

  it("expõe exatamente as seis intenções de resposta", () => {
    expect(REPLY_INTENTS).toEqual([
      "interested",
      "question_or_objection",
      "not_now",
      "no",
      "opt_out",
      "out_of_scope",
    ]);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/db/types.test.ts`
Esperado: FAIL — não consegue resolver `src/db/types.js`.

- [ ] **Step 4: Implementar `src/db/types.ts`**

```typescript
export const LEAD_STAGES = [
  "discovered",
  "enriched",
  "contacted",
  "in_conversation",
  "meeting_booked",
  "discarded",
  "error",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const REPLY_INTENTS = [
  "interested",
  "question_or_objection",
  "not_now",
  "no",
  "opt_out",
  "out_of_scope",
] as const;

export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  niche_description: string;
  filters: unknown | null;
  offer_description: string;
  tone: string;
  scheduling_link: string;
  daily_send_limit: number;
  status: "active" | "paused" | "archived";
  created_at: string;
}

export interface Company {
  id: string;
  tenant_id: string;
  campaign_id: string;
  cnpj: string | null;
  legal_name: string;
  trade_name: string | null;
  website: string | null;
  city: string | null;
  uf: string | null;
  employee_count: number | null;
  summary: string | null;
  source: string;
  enrichment_status: "pending" | "enriched" | "failed";
  created_at: string;
}

export interface Lead {
  id: string;
  tenant_id: string;
  campaign_id: string;
  company_id: string;
  full_name: string | null;
  role_title: string | null;
  email: string;
  email_verified: boolean;
  stage: LeadStage;
  discard_reason: string | null;
  exchange_count: number;
  resume_at: string | null;
  needs_human: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  tenant_id: string;
  lead_id: string;
  direction: "outbound" | "inbound";
  subject: string | null;
  body: string;
  intent: ReplyIntent | null;
  confidence: number | null;
  ai_reasoning: string | null;
  external_id: string | null;
  created_at: string;
}

export interface SuppressionEntry {
  id: string;
  tenant_id: string;
  value: string;
  kind: "email" | "domain";
  reason: string | null;
  created_at: string;
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/db/types.test.ts`
Esperado: PASS (2 testes).

- [ ] **Step 6: Implementar `src/db/client.ts`**

```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

let cache: SupabaseClient | null = null;

/** Cliente Supabase com a service role key — uso exclusivo em backend. */
export function getSupabase(): SupabaseClient {
  if (!cache) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
    cache = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return cache;
}
```

- [ ] **Step 7: Rodar o typecheck**

Run: `npm run typecheck`
Esperado: sem erros.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0001_initial_schema.sql src/db/types.ts src/db/client.ts tests/db/types.test.ts
git commit -m "feat: schema inicial do banco e tipos de domínio"
```

> **Nota de verificação manual:** a migration só é validada quando aplicada a um projeto Supabase real. Ao provisionar o projeto, rode o SQL no editor do Supabase e confirme com `select table_name from information_schema.tables where table_schema = 'public';` — devem aparecer as sete tabelas (`tenants`, `campaigns`, `companies`, `leads`, `messages`, `suppression_list`, `events`).

---

### Task 3: Máquina de estágios do funil

**Files:**
- Create: `src/domain/stages.ts`
- Test: `tests/domain/stages.test.ts`

**Interfaces:**
- Consumes: `LeadStage`, `LEAD_STAGES` de `src/db/types.ts`.
- Produces:
  - `canTransition(from: LeadStage, to: LeadStage): boolean`
  - `assertTransition(from: LeadStage, to: LeadStage): void` — lança `Error` se inválida.
  - `isTerminal(stage: LeadStage): boolean`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/domain/stages.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  isTerminal,
} from "../../src/domain/stages.js";

describe("canTransition", () => {
  it("permite o caminho feliz completo do funil", () => {
    expect(canTransition("discovered", "enriched")).toBe(true);
    expect(canTransition("enriched", "contacted")).toBe(true);
    expect(canTransition("contacted", "in_conversation")).toBe(true);
    expect(canTransition("in_conversation", "meeting_booked")).toBe(true);
  });

  it("permite descartar a partir de qualquer estágio não terminal", () => {
    expect(canTransition("discovered", "discarded")).toBe(true);
    expect(canTransition("enriched", "discarded")).toBe(true);
    expect(canTransition("contacted", "discarded")).toBe(true);
    expect(canTransition("in_conversation", "discarded")).toBe(true);
  });

  it("permite marcar erro a partir de qualquer estágio não terminal", () => {
    expect(canTransition("discovered", "error")).toBe(true);
    expect(canTransition("in_conversation", "error")).toBe(true);
  });

  it("proíbe pular etapas do funil", () => {
    expect(canTransition("discovered", "contacted")).toBe(false);
    expect(canTransition("enriched", "meeting_booked")).toBe(false);
  });

  it("proíbe retroceder no funil", () => {
    expect(canTransition("contacted", "enriched")).toBe(false);
    expect(canTransition("meeting_booked", "in_conversation")).toBe(false);
  });

  it("proíbe sair de estágios terminais", () => {
    expect(canTransition("meeting_booked", "discarded")).toBe(false);
    expect(canTransition("discarded", "contacted")).toBe(false);
  });

  it("permite sair de erro voltando ao estágio de origem para reprocessar", () => {
    expect(canTransition("error", "discovered")).toBe(true);
    expect(canTransition("error", "enriched")).toBe(true);
    expect(canTransition("error", "contacted")).toBe(true);
    expect(canTransition("error", "in_conversation")).toBe(true);
  });

  it("trata transição para o mesmo estágio como inválida", () => {
    expect(canTransition("contacted", "contacted")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("não lança em transição válida", () => {
    expect(() => assertTransition("enriched", "contacted")).not.toThrow();
  });

  it("lança citando origem e destino em transição inválida", () => {
    expect(() => assertTransition("discovered", "meeting_booked")).toThrow(
      /discovered.*meeting_booked/,
    );
  });
});

describe("isTerminal", () => {
  it("reconhece reunião marcada e descartado como terminais", () => {
    expect(isTerminal("meeting_booked")).toBe(true);
    expect(isTerminal("discarded")).toBe(true);
  });

  it("não considera erro terminal, pois é reprocessável", () => {
    expect(isTerminal("error")).toBe(false);
  });

  it("não considera estágios do meio do funil terminais", () => {
    expect(isTerminal("contacted")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/domain/stages.test.ts`
Esperado: FAIL — não consegue resolver `src/domain/stages.js`.

- [ ] **Step 3: Implementar `src/domain/stages.ts`**

```typescript
import type { LeadStage } from "../db/types.js";

const TERMINAIS: readonly LeadStage[] = ["meeting_booked", "discarded"];

/** Avanços permitidos no funil, sem contar descarte e erro. */
const AVANCOS: Record<LeadStage, readonly LeadStage[]> = {
  discovered: ["enriched"],
  enriched: ["contacted"],
  contacted: ["in_conversation"],
  in_conversation: ["meeting_booked"],
  meeting_booked: [],
  discarded: [],
  // Erro é reprocessável: volta para qualquer estágio ativo do funil.
  error: ["discovered", "enriched", "contacted", "in_conversation"],
};

export function isTerminal(stage: LeadStage): boolean {
  return TERMINAIS.includes(stage);
}

export function canTransition(from: LeadStage, to: LeadStage): boolean {
  if (from === to) return false;
  if (isTerminal(from)) return false;
  if (AVANCOS[from].includes(to)) return true;
  // Descarte e erro são alcançáveis de qualquer estágio ativo, inclusive 'error'.
  return to === "discarded" || to === "error";
}

export function assertTransition(from: LeadStage, to: LeadStage): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transição de estágio inválida: ${from} -> ${to}`);
  }
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/domain/stages.test.ts`
Esperado: PASS (13 testes).

- [ ] **Step 5: Commit**

```bash
git add src/domain/stages.ts tests/domain/stages.test.ts
git commit -m "feat: máquina de estágios do funil com transições validadas"
```

---

### Task 4: Regras de supressão

**Files:**
- Create: `src/domain/suppression.ts`
- Test: `tests/domain/suppression.test.ts`

**Interfaces:**
- Consumes: nada além de tipos locais.
- Produces:
  - `normalizeEmail(email: string): string`
  - `extractDomain(email: string): string`
  - `type SuppressionRule = { kind: "email" | "domain"; value: string }`
  - `isSuppressed(email: string, rules: readonly SuppressionRule[]): boolean`
  - `ruleForOptOut(email: string): SuppressionRule`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/domain/suppression.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  extractDomain,
  isSuppressed,
  ruleForOptOut,
  type SuppressionRule,
} from "../../src/domain/suppression.js";

describe("normalizeEmail", () => {
  it("converte para minúsculas e remove espaços nas pontas", () => {
    expect(normalizeEmail("  Joao.Silva@Empresa.COM.BR ")).toBe(
      "joao.silva@empresa.com.br",
    );
  });

  it("lança erro em endereço sem arroba", () => {
    expect(() => normalizeEmail("nao-e-email")).toThrow(/inválido/);
  });

  it("lança erro em endereço vazio", () => {
    expect(() => normalizeEmail("   ")).toThrow(/inválido/);
  });
});

describe("extractDomain", () => {
  it("extrai o domínio normalizado", () => {
    expect(extractDomain("Joao@Empresa.com.BR")).toBe("empresa.com.br");
  });

  it("usa o último arroba em endereços com mais de um", () => {
    expect(extractDomain("estranho@interno@empresa.com")).toBe("empresa.com");
  });
});

describe("isSuppressed", () => {
  const regras: SuppressionRule[] = [
    { kind: "email", value: "chato@empresa.com" },
    { kind: "domain", value: "concorrente.com.br" },
  ];

  it("bloqueia e-mail que consta na lista", () => {
    expect(isSuppressed("chato@empresa.com", regras)).toBe(true);
  });

  it("bloqueia ignorando maiúsculas e espaços", () => {
    expect(isSuppressed("  CHATO@Empresa.com ", regras)).toBe(true);
  });

  it("bloqueia qualquer endereço de domínio suprimido", () => {
    expect(isSuppressed("qualquer.um@concorrente.com.br", regras)).toBe(true);
  });

  it("libera endereço que não consta na lista", () => {
    expect(isSuppressed("novo@empresa.com", regras)).toBe(false);
  });

  it("não confunde sufixo de domínio com domínio suprimido", () => {
    expect(isSuppressed("alvo@naoconcorrente.com.br", regras)).toBe(false);
  });

  it("libera qualquer endereço quando a lista está vazia", () => {
    expect(isSuppressed("alguem@empresa.com", [])).toBe(false);
  });

  it("trata e-mail malformado como suprimido, por segurança", () => {
    expect(isSuppressed("sem-arroba", regras)).toBe(true);
  });
});

describe("ruleForOptOut", () => {
  it("gera regra de e-mail normalizada", () => {
    expect(ruleForOptOut(" Pessoa@Empresa.COM ")).toEqual({
      kind: "email",
      value: "pessoa@empresa.com",
    });
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/domain/suppression.test.ts`
Esperado: FAIL — não consegue resolver `src/domain/suppression.js`.

- [ ] **Step 3: Implementar `src/domain/suppression.ts`**

```typescript
export interface SuppressionRule {
  kind: "email" | "domain";
  value: string;
}

export function normalizeEmail(email: string): string {
  const limpo = email.trim().toLowerCase();
  if (!limpo.includes("@") || limpo.startsWith("@") || limpo.endsWith("@")) {
    throw new Error(`E-mail inválido: ${email}`);
  }
  return limpo;
}

export function extractDomain(email: string): string {
  const normalizado = normalizeEmail(email);
  const posicao = normalizado.lastIndexOf("@");
  return normalizado.slice(posicao + 1);
}

/**
 * Um e-mail malformado é tratado como suprimido: preferimos perder um lead a
 * disparar para um endereço que não conseguimos validar.
 */
export function isSuppressed(
  email: string,
  rules: readonly SuppressionRule[],
): boolean {
  let normalizado: string;
  let dominio: string;
  try {
    normalizado = normalizeEmail(email);
    dominio = extractDomain(email);
  } catch {
    return true;
  }

  return rules.some((regra) => {
    const valor = regra.value.trim().toLowerCase();
    return regra.kind === "email" ? valor === normalizado : valor === dominio;
  });
}

export function ruleForOptOut(email: string): SuppressionRule {
  return { kind: "email", value: normalizeEmail(email) };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/domain/suppression.test.ts`
Esperado: PASS (13 testes).

- [ ] **Step 5: Commit**

```bash
git add src/domain/suppression.ts tests/domain/suppression.test.ts
git commit -m "feat: normalização de e-mail e regras de supressão"
```

---

### Task 5: Cliente Anthropic e interpretação do nicho

**Files:**
- Create: `src/ai/client.ts`
- Create: `src/ai/niche-parser.ts`
- Test: `tests/ai/niche-parser.test.ts`

**Interfaces:**
- Consumes: `env()` da Task 1.
- Produces:
  - `MODEL = "claude-opus-5"` (constante exportada, usada por todos os módulos de IA).
  - `getClient(): Anthropic`
  - `type AiDeps = { client: Pick<Anthropic, "messages"> }`
  - `NicheFiltersSchema` (Zod) e `type NicheFilters = { cnaes: string[]; ufs: string[]; cities: string[]; min_employees: number | null; max_employees: number | null; target_roles: string[]; keywords: string[] }`
  - `parseNiche(description: string, deps?: AiDeps): Promise<NicheFilters>`

- [ ] **Step 1: Implementar `src/ai/client.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";

/** Modelo único de toda a plataforma. */
export const MODEL = "claude-opus-5";

let cache: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!cache) {
    cache = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  }
  return cache;
}

/** Dependências injetáveis dos módulos de IA — permite testar sem rede. */
export interface AiDeps {
  client: Pick<Anthropic, "messages">;
}
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `tests/ai/niche-parser.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { parseNiche } from "../../src/ai/niche-parser.js";
import type { AiDeps } from "../../src/ai/client.js";

const FILTROS = {
  cnaes: ["1091101"],
  ufs: ["SC"],
  cities: [],
  min_employees: 50,
  max_employees: null,
  target_roles: ["Gerente de TI"],
  keywords: ["indústria de alimentos"],
};

function depsComParse(parse: ReturnType<typeof vi.fn>): AiDeps {
  return { client: { messages: { parse } } } as unknown as AiDeps;
}

describe("parseNiche", () => {
  it("devolve os filtros estruturados retornados pelo modelo", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: FILTROS, stop_reason: "end_turn" });

    const resultado = await parseNiche(
      "indústrias de alimentos em SC com 50+ funcionários, falar com gerente de TI",
      depsComParse(parse),
    );

    expect(resultado).toEqual(FILTROS);
  });

  it("chama o modelo configurado com system cacheável e saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: FILTROS, stop_reason: "end_turn" });

    await parseNiche("clínicas odontológicas em SP", depsComParse(parse));

    const argumentos = parse.mock.calls[0]![0];
    expect(argumentos.model).toBe("claude-opus-5");
    expect(argumentos.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(argumentos.output_config.format).toBeDefined();
    expect(argumentos.messages).toEqual([
      { role: "user", content: "clínicas odontológicas em SP" },
    ]);
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });

    await expect(parseNiche("qualquer nicho", depsComParse(parse))).rejects.toThrow(
      /saída estruturada/,
    );
  });

  it("rejeita descrição vazia sem chamar o modelo", async () => {
    const parse = vi.fn();
    await expect(parseNiche("   ", depsComParse(parse))).rejects.toThrow(
      /descrição do nicho/i,
    );
    expect(parse).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/ai/niche-parser.test.ts`
Esperado: FAIL — não consegue resolver `src/ai/niche-parser.js`.

- [ ] **Step 4: Implementar `src/ai/niche-parser.ts`**

```typescript
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";

export const NicheFiltersSchema = z.object({
  cnaes: z.array(z.string()),
  ufs: z.array(z.string()),
  cities: z.array(z.string()),
  min_employees: z.number().nullable(),
  max_employees: z.number().nullable(),
  target_roles: z.array(z.string()),
  keywords: z.array(z.string()),
});

export type NicheFilters = z.infer<typeof NicheFiltersSchema>;

/**
 * Prompt fixo: é o prefixo cacheado. Qualquer alteração aqui invalida o cache
 * de todas as campanhas, então mantenha estável.
 */
const SYSTEM = `Você converte descrições de nicho de prospecção B2B no Brasil em filtros de busca estruturados.

Regras:
- cnaes: códigos CNAE de 7 dígitos, apenas números, somente quando a atividade descrita corresponde claramente ao código. Nunca invente um CNAE.
- ufs: siglas de duas letras maiúsculas. Lista vazia significa Brasil inteiro.
- cities: nomes de cidades exatamente como escritos na descrição.
- min_employees e max_employees: null quando a descrição não menciona porte.
- target_roles: cargos do decisor em português, na forma como aparecem em títulos reais (por exemplo "Gerente de TI", "Diretor de Operações").
- keywords: termos para busca textual complementar, incluindo qualquer atividade que você não conseguiu mapear para um CNAE.

Na dúvida sobre um CNAE, deixe-o de fora e coloque o termo em keywords.`;

export async function parseNiche(
  description: string,
  deps: AiDeps = { client: getClient() },
): Promise<NicheFilters> {
  if (description.trim().length === 0) {
    throw new Error("A descrição do nicho não pode estar vazia.");
  }

  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      format: zodOutputFormat(NicheFiltersSchema),
      effort: "medium",
    },
    messages: [{ role: "user", content: description }],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para o nicho (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/ai/niche-parser.test.ts`
Esperado: PASS (4 testes).

- [ ] **Step 6: Verificação manual contra a API real**

Este é o primeiro uso de `zodOutputFormat` + `messages.parse` no projeto — confirme que a combinação de versões funciona de verdade antes de replicar o padrão nas próximas tasks.

Criar `scripts/smoke-niche.ts`:

```typescript
import { parseNiche } from "../src/ai/niche-parser.js";

const filtros = await parseNiche(
  "indústrias de alimentos em Santa Catarina com mais de 50 funcionários, quero falar com o gerente de TI",
);
console.log(JSON.stringify(filtros, null, 2));
```

Run: `npx tsx scripts/smoke-niche.ts` (com `ANTHROPIC_API_KEY` no ambiente)
Esperado: imprime um objeto JSON com as sete chaves; `ufs` contém `"SC"` e `target_roles` menciona TI.

Se não houver chave de API disponível, pule este passo e registre a pendência. A compatibilidade de versões já foi validada estaticamente com `@anthropic-ai/sdk@0.122.0` + `zod@3.25.x`: `zodOutputFormat` é exportado por `@anthropic-ai/sdk/helpers/zod`, `client.messages.parse` existe, `output_config` aceita `effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'`, e o campo de retorno é `parsed_output`. O que o smoke test acrescenta é a validação de comportamento em runtime (qualidade da saída do modelo), não de assinatura — o `npm run typecheck` cobre a assinatura.

- [ ] **Step 7: Commit**

```bash
git add src/ai/client.ts src/ai/niche-parser.ts tests/ai/niche-parser.test.ts scripts/smoke-niche.ts
git commit -m "feat: cliente Anthropic e interpretação de nicho em filtros estruturados"
```

---

### Task 6: Redação do e-mail de primeiro contato

**Files:**
- Create: `src/ai/email-writer.ts`
- Test: `tests/ai/email-writer.test.ts`

**Interfaces:**
- Consumes: `MODEL`, `getClient`, `AiDeps` de `src/ai/client.ts`.
- Produces:
  - `EmailDraftSchema` (Zod) e `type EmailDraft = { subject: string; body: string }`
  - `type CampaignVoice = { offerDescription: string; tone: string }`
  - `type CompanyContext = { legalName: string; tradeName: string | null; summary: string | null; city: string | null; uf: string | null }`
  - `type LeadContext = { fullName: string | null; roleTitle: string | null }`
  - `writeFirstEmail(input: { voice: CampaignVoice; company: CompanyContext; lead: LeadContext }, deps?: AiDeps): Promise<EmailDraft>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/ai/email-writer.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { writeFirstEmail } from "../../src/ai/email-writer.js";
import type { AiDeps } from "../../src/ai/client.js";

const RASCUNHO = {
  subject: "Integração de dados na Alfa Alimentos",
  body: "Olá Maria, ...",
};

function depsComParse(parse: ReturnType<typeof vi.fn>): AiDeps {
  return { client: { messages: { parse } } } as unknown as AiDeps;
}

const ENTRADA = {
  voice: {
    offerDescription: "Consultoria de dados e BI para indústrias.",
    tone: "consultivo, direto, sem jargão",
  },
  company: {
    legalName: "Alfa Alimentos LTDA",
    tradeName: "Alfa Alimentos",
    summary: "Fabricante de congelados com três plantas em SC.",
    city: "Joinville",
    uf: "SC",
  },
  lead: { fullName: "Maria Souza", roleTitle: "Gerente de TI" },
};

describe("writeFirstEmail", () => {
  it("devolve o rascunho retornado pelo modelo", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });

    const resultado = await writeFirstEmail(ENTRADA, depsComParse(parse));

    expect(resultado).toEqual(RASCUNHO);
  });

  it("mantém a oferta e o tom no system cacheável e os dados da empresa no turno do usuário", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });

    await writeFirstEmail(ENTRADA, depsComParse(parse));

    const argumentos = parse.mock.calls[0]![0];
    const system = argumentos.system[0];
    expect(system.text).toContain("Consultoria de dados e BI para indústrias.");
    expect(system.text).toContain("consultivo, direto, sem jargão");
    expect(system.cache_control).toEqual({ type: "ephemeral" });
    // Dados voláteis ficam fora do prefixo cacheado.
    expect(system.text).not.toContain("Alfa Alimentos");

    const turnoUsuario = argumentos.messages[0].content as string;
    expect(turnoUsuario).toContain("Alfa Alimentos");
    expect(turnoUsuario).toContain("Maria Souza");
    expect(turnoUsuario).toContain("Gerente de TI");
  });

  it("produz o mesmo system para empresas diferentes da mesma campanha", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });
    const deps = depsComParse(parse);

    await writeFirstEmail(ENTRADA, deps);
    await writeFirstEmail(
      {
        ...ENTRADA,
        company: { ...ENTRADA.company, legalName: "Beta Foods LTDA" },
      },
      deps,
    );

    expect(parse.mock.calls[0]![0].system[0].text).toBe(
      parse.mock.calls[1]![0].system[0].text,
    );
  });

  it("lida com empresa sem resumo e lead sem nome", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });

    await writeFirstEmail(
      {
        ...ENTRADA,
        company: { ...ENTRADA.company, summary: null },
        lead: { fullName: null, roleTitle: "Diretor" },
      },
      depsComParse(parse),
    );

    const turnoUsuario = parse.mock.calls[0]![0].messages[0].content as string;
    expect(turnoUsuario).toContain("não disponível");
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });

    await expect(writeFirstEmail(ENTRADA, depsComParse(parse))).rejects.toThrow(
      /saída estruturada/,
    );
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/ai/email-writer.test.ts`
Esperado: FAIL — não consegue resolver `src/ai/email-writer.js`.

- [ ] **Step 3: Implementar `src/ai/email-writer.ts`**

```typescript
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";

export const EmailDraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export type EmailDraft = z.infer<typeof EmailDraftSchema>;

export interface CampaignVoice {
  offerDescription: string;
  tone: string;
}

export interface CompanyContext {
  legalName: string;
  tradeName: string | null;
  summary: string | null;
  city: string | null;
  uf: string | null;
}

export interface LeadContext {
  fullName: string | null;
  roleTitle: string | null;
}

const AUSENTE = "não disponível";

/**
 * Só depende da campanha, nunca do lead — é o prefixo cacheado, reaproveitado
 * em todos os e-mails da mesma campanha.
 */
export function buildVoiceSystem(voice: CampaignVoice): string {
  return `Você escreve e-mails de primeiro contato (cold e-mail) B2B em português brasileiro.

O que oferecemos:
${voice.offerDescription}

Tom de voz: ${voice.tone}

Regras invioláveis:
- Máximo de 120 palavras no corpo.
- Assunto com no máximo 60 caracteres, sem emoji, sem promessa exagerada, sem "urgente".
- Nunca cite preço, desconto ou condição comercial.
- Nunca invente fatos sobre a empresa do destinatário: use apenas o que estiver no contexto fornecido.
- Nunca inclua link de agendamento neste primeiro e-mail.
- Faça uma única pergunta clara no final, de baixo compromisso.
- Não use saudações genéricas do tipo "Espero que esteja tudo bem".
- Assine apenas com o primeiro nome do remetente, sem bloco de assinatura.`;
}

function buildLeadPrompt(company: CompanyContext, lead: LeadContext): string {
  const localizacao = [company.city, company.uf].filter(Boolean).join("/");
  return `Escreva o e-mail para este destinatário.

Empresa: ${company.tradeName ?? company.legalName}
Razão social: ${company.legalName}
Localização: ${localizacao || AUSENTE}
O que a empresa faz: ${company.summary ?? AUSENTE}

Destinatário: ${lead.fullName ?? AUSENTE}
Cargo: ${lead.roleTitle ?? AUSENTE}`;
}

export async function writeFirstEmail(
  input: { voice: CampaignVoice; company: CompanyContext; lead: LeadContext },
  deps: AiDeps = { client: getClient() },
): Promise<EmailDraft> {
  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: buildVoiceSystem(input.voice),
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      format: zodOutputFormat(EmailDraftSchema),
      effort: "medium",
    },
    messages: [
      { role: "user", content: buildLeadPrompt(input.company, input.lead) },
    ],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para o e-mail (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/ai/email-writer.test.ts`
Esperado: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/ai/email-writer.ts tests/ai/email-writer.test.ts
git commit -m "feat: redação do e-mail de primeiro contato com prefixo cacheável por campanha"
```

---

### Task 7: Classificação da resposta do lead

**Files:**
- Create: `src/ai/reply-classifier.ts`
- Test: `tests/ai/reply-classifier.test.ts`

**Interfaces:**
- Consumes: `MODEL`, `getClient`, `AiDeps` de `src/ai/client.ts`; `REPLY_INTENTS`, `ReplyIntent` de `src/db/types.ts`.
- Produces:
  - `ReplyClassificationSchema` (Zod) e `type ReplyClassification = { intent: ReplyIntent; confidence: number; reasoning: string; key_points: string[] }`
  - `classifyReply(replyBody: string, deps?: AiDeps): Promise<ReplyClassification>`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/ai/reply-classifier.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { classifyReply } from "../../src/ai/reply-classifier.js";
import type { AiDeps } from "../../src/ai/client.js";

function depsComParse(parse: ReturnType<typeof vi.fn>): AiDeps {
  return { client: { messages: { parse } } } as unknown as AiDeps;
}

function classificacao(overrides: Record<string, unknown> = {}) {
  return {
    intent: "interested",
    confidence: 0.9,
    reasoning: "Pediu para conversar na semana que vem.",
    key_points: ["quer conversar"],
    ...overrides,
  };
}

describe("classifyReply", () => {
  it("devolve a classificação retornada pelo modelo", async () => {
    const esperado = classificacao();
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: esperado, stop_reason: "end_turn" });

    const resultado = await classifyReply(
      "Podemos conversar semana que vem?",
      depsComParse(parse),
    );

    expect(resultado).toEqual(esperado);
  });

  it("limita a confiança ao intervalo de 0 a 1", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: classificacao({ confidence: 1.7 }),
      stop_reason: "end_turn",
    });

    const acima = await classifyReply("Vamos marcar!", depsComParse(parse));
    expect(acima.confidence).toBe(1);

    parse.mockResolvedValue({
      parsed_output: classificacao({ confidence: -0.4 }),
      stop_reason: "end_turn",
    });
    const abaixo = await classifyReply("Não entendi", depsComParse(parse));
    expect(abaixo.confidence).toBe(0);
  });

  it("usa confiança zero quando o modelo devolve um número inválido", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: classificacao({ confidence: Number.NaN }),
      stop_reason: "end_turn",
    });

    const resultado = await classifyReply("Texto ambíguo", depsComParse(parse));
    expect(resultado.confidence).toBe(0);
  });

  it("usa o modelo configurado com system cacheável e esforço baixo", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: classificacao(), stop_reason: "end_turn" });

    await classifyReply("Obrigado, não temos interesse.", depsComParse(parse));

    const argumentos = parse.mock.calls[0]![0];
    expect(argumentos.model).toBe("claude-opus-5");
    expect(argumentos.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(argumentos.output_config.effort).toBe("low");
  });

  it("rejeita resposta vazia sem chamar o modelo", async () => {
    const parse = vi.fn();
    await expect(classifyReply("  ", depsComParse(parse))).rejects.toThrow(
      /resposta vazia/i,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });

    await expect(classifyReply("Qualquer texto", depsComParse(parse))).rejects.toThrow(
      /saída estruturada/,
    );
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/ai/reply-classifier.test.ts`
Esperado: FAIL — não consegue resolver `src/ai/reply-classifier.js`.

- [ ] **Step 3: Implementar `src/ai/reply-classifier.ts`**

```typescript
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";
import { REPLY_INTENTS } from "../db/types.js";

export const ReplyClassificationSchema = z.object({
  intent: z.enum(REPLY_INTENTS),
  confidence: z.number(),
  reasoning: z.string(),
  key_points: z.array(z.string()),
});

export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;

const SYSTEM = `Você classifica respostas a e-mails de prospecção B2B em português brasileiro.

Escolha exatamente uma intenção:
- interested: demonstra interesse em conversar, pede reunião, pergunta por disponibilidade.
- question_or_objection: quer conversar mas antes tem dúvida, ressalva ou objeção a tratar.
- not_now: há interesse, mas o momento não é agora ("me procure em três meses").
- no: recusa clara, sem interesse, sem pedir para parar de receber contato.
- opt_out: pede explicitamente para ser removido, descadastrado ou para não receber mais e-mails.
- out_of_scope: não é uma resposta humana à proposta — resposta automática de ausência, aviso de entrega, encaminhamento sem conteúdo, pessoa que saiu da empresa.

confidence: sua certeza na classificação, de 0 a 1. Use valor abaixo de 0,7 quando o texto for ambíguo, muito curto ou puder ter mais de uma leitura — um humano vai revisar esses casos.
reasoning: uma frase em português explicando a escolha.
key_points: os pontos concretos levantados pelo lead que a resposta precisa endereçar. Lista vazia se não houver nenhum.

Na dúvida entre "no" e "opt_out", escolha "opt_out": deixar de contatar alguém que queria conversar custa menos do que insistir com quem pediu para parar.`;

function clampConfidence(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.min(1, Math.max(0, valor));
}

export async function classifyReply(
  replyBody: string,
  deps: AiDeps = { client: getClient() },
): Promise<ReplyClassification> {
  if (replyBody.trim().length === 0) {
    throw new Error("Não é possível classificar uma resposta vazia.");
  }

  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    output_config: {
      format: zodOutputFormat(ReplyClassificationSchema),
      effort: "low",
    },
    messages: [
      { role: "user", content: `Resposta recebida:\n\n${replyBody}` },
    ],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para a classificação (stop_reason=${resposta.stop_reason}).`,
    );
  }

  return {
    ...resposta.parsed_output,
    confidence: clampConfidence(resposta.parsed_output.confidence),
  };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/ai/reply-classifier.test.ts`
Esperado: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/ai/reply-classifier.ts tests/ai/reply-classifier.test.ts
git commit -m "feat: classificação de respostas de lead em seis intenções"
```

---

### Task 8: Política de resposta e travas de segurança

Este é o módulo que decide o que a automação faz com cada resposta. Ele é puro (sem IA, sem rede) porque é onde moram as travas de segurança do spec — precisa ser exaustivamente testável.

**Files:**
- Create: `src/domain/reply-policy.ts`
- Test: `tests/domain/reply-policy.test.ts`

**Interfaces:**
- Consumes: `ReplyClassification` de `src/ai/reply-classifier.ts`.
- Produces:
  - `CONFIDENCE_THRESHOLD = 0.7`, `MAX_EXCHANGES = 5`, `NOT_NOW_RESUME_DAYS = 90`
  - `type NextAction =`
    `{ type: "send_scheduling_link" }` |
    `{ type: "answer_and_nudge"; keyPoints: string[] }` |
    `{ type: "schedule_followup"; resumeInDays: number }` |
    `{ type: "close_lost"; reason: string; suppress: boolean }` |
    `{ type: "handoff_to_human"; reason: string }` |
    `{ type: "ignore"; reason: string }`
  - `decideNextAction(input: { classification: ReplyClassification; exchangeCount: number }): NextAction`

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/domain/reply-policy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  decideNextAction,
  CONFIDENCE_THRESHOLD,
  MAX_EXCHANGES,
  NOT_NOW_RESUME_DAYS,
} from "../../src/domain/reply-policy.js";
import type { ReplyClassification } from "../../src/ai/reply-classifier.js";

function classificacao(
  overrides: Partial<ReplyClassification> = {},
): ReplyClassification {
  return {
    intent: "interested",
    confidence: 0.95,
    reasoning: "motivo",
    key_points: [],
    ...overrides,
  };
}

describe("decideNextAction — caminhos por intenção", () => {
  it("envia o link de agendamento para lead interessado", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "interested" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({ type: "send_scheduling_link" });
  });

  it("responde e conduz ao agendamento quando há dúvida ou objeção", () => {
    const acao = decideNextAction({
      classification: classificacao({
        intent: "question_or_objection",
        key_points: ["preço", "prazo"],
      }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "answer_and_nudge",
      keyPoints: ["preço", "prazo"],
    });
  });

  it("agenda retomada futura em 'não agora'", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "not_now" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "schedule_followup",
      resumeInDays: NOT_NOW_RESUME_DAYS,
    });
  });

  it("encerra sem suprimir em recusa simples", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "no" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "recusa do lead",
      suppress: false,
    });
  });

  it("encerra e suprime em pedido de descadastro", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "opt_out" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "pedido de descadastro",
      suppress: true,
    });
  });

  it("ignora respostas fora do escopo", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "out_of_scope" }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "ignore",
      reason: "resposta fora do escopo",
    });
  });
});

describe("decideNextAction — travas de segurança", () => {
  it("honra o descadastro mesmo com confiança baixa", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "opt_out", confidence: 0.1 }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "pedido de descadastro",
      suppress: true,
    });
  });

  it("honra o descadastro mesmo com a conversa já longa", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "opt_out" }),
      exchangeCount: 99,
    });
    expect(acao.type).toBe("close_lost");
  });

  it("passa para humano quando a confiança fica abaixo do limite", () => {
    const acao = decideNextAction({
      classification: classificacao({
        intent: "interested",
        confidence: CONFIDENCE_THRESHOLD - 0.01,
      }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    });
  });

  it("aceita a classificação exatamente no limite de confiança", () => {
    const acao = decideNextAction({
      classification: classificacao({ confidence: CONFIDENCE_THRESHOLD }),
      exchangeCount: 1,
    });
    expect(acao).toEqual({ type: "send_scheduling_link" });
  });

  it("passa para humano ao atingir o teto de trocas", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "question_or_objection" }),
      exchangeCount: MAX_EXCHANGES,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "conversa longa sem desfecho",
    });
  });

  it("ainda automatiza na troca imediatamente anterior ao teto", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "question_or_objection" }),
      exchangeCount: MAX_EXCHANGES - 1,
    });
    expect(acao.type).toBe("answer_and_nudge");
  });

  it("encerra recusa clara sem passar por humano, mesmo em conversa longa", () => {
    const acao = decideNextAction({
      classification: classificacao({ intent: "no" }),
      exchangeCount: MAX_EXCHANGES + 3,
    });
    expect(acao).toEqual({
      type: "close_lost",
      reason: "recusa do lead",
      suppress: false,
    });
  });

  it("prioriza confiança baixa sobre o teto de trocas", () => {
    const acao = decideNextAction({
      classification: classificacao({ confidence: 0.2 }),
      exchangeCount: MAX_EXCHANGES + 1,
    });
    expect(acao).toEqual({
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    });
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/domain/reply-policy.test.ts`
Esperado: FAIL — não consegue resolver `src/domain/reply-policy.js`.

- [ ] **Step 3: Implementar `src/domain/reply-policy.ts`**

```typescript
import type { ReplyClassification } from "../ai/reply-classifier.js";

/** Abaixo disso, um humano decide. */
export const CONFIDENCE_THRESHOLD = 0.7;

/** Trocas com o lead antes de a automação entregar a conversa a um humano. */
export const MAX_EXCHANGES = 5;

/** Espera antes de retomar um lead que pediu para ser procurado depois. */
export const NOT_NOW_RESUME_DAYS = 90;

export type NextAction =
  | { type: "send_scheduling_link" }
  | { type: "answer_and_nudge"; keyPoints: string[] }
  | { type: "schedule_followup"; resumeInDays: number }
  | { type: "close_lost"; reason: string; suppress: boolean }
  | { type: "handoff_to_human"; reason: string }
  | { type: "ignore"; reason: string };

export function decideNextAction(input: {
  classification: ReplyClassification;
  exchangeCount: number;
}): NextAction {
  const { classification, exchangeCount } = input;

  // Descadastro vem antes de qualquer trava: continuar escrevendo para quem
  // pediu para parar é pior — e mais arriscado sob a LGPD — do que perder o lead.
  if (classification.intent === "opt_out") {
    return {
      type: "close_lost",
      reason: "pedido de descadastro",
      suppress: true,
    };
  }

  if (classification.confidence < CONFIDENCE_THRESHOLD) {
    return {
      type: "handoff_to_human",
      reason: "classificação com confiança baixa",
    };
  }

  // Recusa clara encerra em vez de virar trabalho para um humano.
  if (classification.intent === "no") {
    return { type: "close_lost", reason: "recusa do lead", suppress: false };
  }

  if (classification.intent === "out_of_scope") {
    return { type: "ignore", reason: "resposta fora do escopo" };
  }

  if (exchangeCount >= MAX_EXCHANGES) {
    return { type: "handoff_to_human", reason: "conversa longa sem desfecho" };
  }

  switch (classification.intent) {
    case "interested":
      return { type: "send_scheduling_link" };
    case "question_or_objection":
      return { type: "answer_and_nudge", keyPoints: classification.key_points };
    case "not_now":
      return {
        type: "schedule_followup",
        resumeInDays: NOT_NOW_RESUME_DAYS,
      };
  }
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/domain/reply-policy.test.ts`
Esperado: PASS (14 testes).

- [ ] **Step 5: Rodar o typecheck**

Run: `npm run typecheck`
Esperado: sem erros. O `switch` final é exaustivo — se um dia surgir uma nova intenção, o TypeScript aponta aqui.

- [ ] **Step 6: Commit**

```bash
git add src/domain/reply-policy.ts tests/domain/reply-policy.test.ts
git commit -m "feat: política de resposta com travas de confiança, teto de trocas e descadastro"
```

---

### Task 9: Redação da réplica ao lead

**Files:**
- Create: `src/ai/reply-writer.ts`
- Test: `tests/ai/reply-writer.test.ts`

**Interfaces:**
- Consumes: `MODEL`, `getClient`, `AiDeps` de `src/ai/client.ts`; `EmailDraftSchema`, `EmailDraft`, `CampaignVoice` de `src/ai/email-writer.ts`; `NextAction` de `src/domain/reply-policy.ts`.
- Produces:
  - `type ConversationTurn = { role: "us" | "lead"; body: string }`
  - `writeReply(input: { voice: CampaignVoice; schedulingLink: string; history: ConversationTurn[]; action: NextAction }, deps?: AiDeps): Promise<EmailDraft>`
  - Lança erro para ações que não geram e-mail (`close_lost` com `suppress`, `handoff_to_human`, `ignore`).

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/ai/reply-writer.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { writeReply, type ConversationTurn } from "../../src/ai/reply-writer.js";
import type { AiDeps } from "../../src/ai/client.js";

const RASCUNHO = { subject: "Re: proposta", body: "Claro, segue o link..." };

function depsComParse(parse: ReturnType<typeof vi.fn>): AiDeps {
  return { client: { messages: { parse } } } as unknown as AiDeps;
}

const VOZ = {
  offerDescription: "Consultoria de dados e BI para indústrias.",
  tone: "consultivo, direto, sem jargão",
};

const LINK = "https://cal.com/thiago/30min";

const HISTORICO: ConversationTurn[] = [
  { role: "us", body: "Olá Maria, vi que a Alfa..." },
  { role: "lead", body: "Interessante. Quanto custa?" },
];

function parseOk() {
  return vi
    .fn()
    .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });
}

describe("writeReply", () => {
  it("devolve o rascunho retornado pelo modelo", async () => {
    const parse = parseOk();
    const resultado = await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    expect(resultado).toEqual(RASCUNHO);
  });

  it("inclui o link de agendamento na instrução quando a ação é enviá-lo", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain(LINK);
  });

  it("lista os pontos a endereçar quando a ação é responder e conduzir", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "answer_and_nudge", keyPoints: ["preço", "prazo"] },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("preço");
    expect(conteudo).toContain("prazo");
    expect(conteudo).toContain(LINK);
  });

  it("transcreve o histórico identificando quem falou", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("Nós: Olá Maria, vi que a Alfa...");
    expect(conteudo).toContain("Lead: Interessante. Quanto custa?");
  });

  it("mantém o tom da campanha no system cacheável", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    const system = parse.mock.calls[0]![0].system[0];
    expect(system.text).toContain("consultivo, direto, sem jargão");
    expect(system.cache_control).toEqual({ type: "ephemeral" });
  });

  it("escreve despedida cordial ao encerrar por recusa", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "close_lost", reason: "recusa do lead", suppress: false },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("agradeça");
    expect(conteudo).not.toContain(LINK);
  });

  it("propõe retomada futura sem link em 'não agora'", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "schedule_followup", resumeInDays: 90 },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("90");
    expect(conteudo).not.toContain(LINK);
  });

  it("recusa gerar e-mail para ação de repasse a humano", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: { type: "handoff_to_human", reason: "conversa longa sem desfecho" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/não gera e-mail/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("recusa gerar e-mail para descadastro", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: {
            type: "close_lost",
            reason: "pedido de descadastro",
            suppress: true,
          },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/não gera e-mail/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("recusa gerar e-mail para resposta fora do escopo", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: { type: "ignore", reason: "resposta fora do escopo" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/não gera e-mail/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("exige histórico não vazio", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: [],
          action: { type: "send_scheduling_link" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/histórico/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: { type: "send_scheduling_link" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/saída estruturada/);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npm test -- tests/ai/reply-writer.test.ts`
Esperado: FAIL — não consegue resolver `src/ai/reply-writer.js`.

- [ ] **Step 3: Implementar `src/ai/reply-writer.ts`**

```typescript
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, getClient, type AiDeps } from "./client.js";
import {
  EmailDraftSchema,
  type EmailDraft,
  type CampaignVoice,
} from "./email-writer.js";
import type { NextAction } from "../domain/reply-policy.js";

export interface ConversationTurn {
  role: "us" | "lead";
  body: string;
}

/**
 * Só depende da campanha — prefixo cacheado, igual para todas as réplicas.
 */
function buildSystem(voice: CampaignVoice): string {
  return `Você responde, em português brasileiro, a leads que reagiram a um e-mail de prospecção B2B.

O que oferecemos:
${voice.offerDescription}

Tom de voz: ${voice.tone}

Regras invioláveis:
- Máximo de 120 palavras no corpo.
- Nunca cite preço, desconto ou condição comercial: diga que isso depende do escopo e que vale conversar.
- Nunca invente casos, números, clientes ou funcionalidades. Se não souber, reconheça e proponha esclarecer na conversa.
- Nunca prometa prazo de entrega ou resultado.
- Responda ao que o lead perguntou antes de propor o próximo passo.
- O assunto deve manter o fio da conversa, com prefixo "Re:".
- Assine apenas com o primeiro nome do remetente, sem bloco de assinatura.`;
}

function transcrever(history: ConversationTurn[]): string {
  return history
    .map((turno) => `${turno.role === "us" ? "Nós" : "Lead"}: ${turno.body}`)
    .join("\n\n");
}

function instrucao(action: NextAction, schedulingLink: string): string {
  switch (action.type) {
    case "send_scheduling_link":
      return `O lead demonstrou interesse. Confirme o interesse em uma frase e convide para escolher um horário neste link: ${schedulingLink}`;
    case "answer_and_nudge": {
      const pontos = action.keyPoints.length
        ? action.keyPoints.map((ponto) => `- ${ponto}`).join("\n")
        : "- a dúvida principal levantada na última mensagem";
      return `O lead levantou pontos antes de aceitar conversar. Responda objetivamente a cada um destes pontos:\n${pontos}\n\nDepois de respondê-los, convide para escolher um horário neste link: ${schedulingLink}`;
    }
    case "schedule_followup":
      return `O lead tem interesse, mas não agora. Não insista e não envie link. Agradeça, deixe a porta aberta e diga que você retoma o contato em cerca de ${action.resumeInDays} dias.`;
    case "close_lost":
      return `O lead recusou. Não insista e não envie link: agradeça o retorno em duas frases, deixe a porta aberta para o futuro e encerre.`;
    default:
      throw new Error(
        `A ação "${action.type}" não gera e-mail para o lead.`,
      );
  }
}

export async function writeReply(
  input: {
    voice: CampaignVoice;
    schedulingLink: string;
    history: ConversationTurn[];
    action: NextAction;
  },
  deps: AiDeps = { client: getClient() },
): Promise<EmailDraft> {
  if (input.history.length === 0) {
    throw new Error("Não é possível responder sem histórico da conversa.");
  }
  // Descadastro é encerrado em silêncio: quem pediu para parar não recebe mais e-mail.
  if (input.action.type === "close_lost" && input.action.suppress) {
    throw new Error(
      "Um pedido de descadastro não gera e-mail de resposta.",
    );
  }

  const tarefa = instrucao(input.action, input.schedulingLink);

  const resposta = await deps.client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: buildSystem(input.voice),
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      format: zodOutputFormat(EmailDraftSchema),
      effort: "medium",
    },
    messages: [
      {
        role: "user",
        content: `Conversa até aqui:\n\n${transcrever(input.history)}\n\nSua tarefa: ${tarefa}`,
      },
    ],
  });

  if (!resposta.parsed_output) {
    throw new Error(
      `O modelo não devolveu saída estruturada para a réplica (stop_reason=${resposta.stop_reason}).`,
    );
  }
  return resposta.parsed_output;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npm test -- tests/ai/reply-writer.test.ts`
Esperado: PASS (12 testes).

- [ ] **Step 5: Rodar a suíte completa e o typecheck**

Run: `npm test && npm run typecheck`
Esperado: todos os arquivos de teste passando, sem erro de tipo.

- [ ] **Step 6: Commit**

```bash
git add src/ai/reply-writer.ts tests/ai/reply-writer.test.ts
git commit -m "feat: redação da réplica ao lead conforme a ação decidida pela política"
```

---

## Cobertura do spec por este plano

| Requisito do spec | Onde é atendido |
|---|---|
| Tabelas com `tenant_id` (§3.2, §7) | Task 2 |
| Funil de estágios (§3.1) | Tasks 2 e 3 |
| Lista de supressão global (§3.2, §5) | Task 4 |
| Nicho em texto livre → filtros (§3.5, Fluxo 1) | Task 5 |
| E-mail personalizado (Fluxo 3) | Task 6 |
| Classificação em seis intenções (Fluxo 4) | Task 7 |
| Ações por classificação (Fluxo 4, item 3) | Task 8 |
| Trava de confiança baixa e de 5 trocas (Fluxo 4) | Task 8 |
| Redação das réplicas (Fluxo 4) | Task 9 |
| Raciocínio da IA auditável (§4, travas) | Task 7 (`reasoning`) + coluna `messages.ai_reasoning` na Task 2 |

**Fora deste plano, por design:** descoberta de empresas, enriquecimento, Instantly, Cal.com, rotas HTTP e disjuntor de bounce (Plano 2); painel web (Plano 3); fluxos n8n e rollout (Plano 4).
