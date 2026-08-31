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
