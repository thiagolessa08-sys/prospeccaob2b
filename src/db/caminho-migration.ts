import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Onde está o .sql do schema, resolvido a partir deste módulo.
 *
 * Vive num arquivo próprio, sem efeito colateral, só para poder ser testado:
 * `migrar.ts` tem top-level await e `process.exit`, então importá-lo num
 * teste executaria a migration.
 *
 * O `../../` vale igual em `src/db/` (via tsx) e em `dist/db/` (compilado) —
 * os dois estão dois níveis abaixo da raiz, que é o que torna o teste em
 * `src/` representativo do que roda em produção. Já esteve errado: o script
 * nasceu em `scripts/`, onde `../` era o certo, e mover o arquivo não corrige
 * o caminho. O deploy foi ao ar procurando `/app/dist/supabase/...` e ficou
 * em loop de crash.
 */
export const CAMINHO_DA_MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../supabase/migrations/0001_initial_schema.sql",
);
