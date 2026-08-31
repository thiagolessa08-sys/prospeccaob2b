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
