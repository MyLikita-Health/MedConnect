/** Postgres connection pool (M0 dev default matches docker-compose). */
import { Pool } from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://hub:hub@localhost:5434/hub';

export function createDbPool(
  url: string | undefined = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
): Pool {
  return new Pool({ connectionString: url, max: 10 });
}

export async function closeDbPool(pool: Pool): Promise<void> {
  await pool.end();
}