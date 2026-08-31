/**
 * Fronteira SQL do sistema.
 *
 * Esta assinatura é deliberadamente a interseção entre `pg.Pool` (produção) e
 * `PGlite` (teste): as duas expõem exatamente `query(text, params)` devolvendo
 * `{ rows }`. É isso que permite rodar o mesmo repositório contra um Postgres
 * de verdade nos testes, em vez de contra um mock.
 *
 * Onde a interseção vaza — confira antes de confiar no tipo de uma coluna:
 *
 * - `numeric`: volta como **string** nos dois drivers (é assim de propósito,
 *   para não perder precisão). Vale para `messages.confidence`.
 * - `int8` (o tipo de `count(*)`): volta como **number** no PGlite e como
 *   **string** no node-pg. Nenhum agregado é usado ainda, mas o próximo
 *   recurso óbvio — impor `campaigns.daily_send_limit` — precisa de
 *   `count(*)` e passaria no teste enquanto quebra em produção. Converta com
 *   `Number()` na saída da consulta.
 */
export interface Db {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}
