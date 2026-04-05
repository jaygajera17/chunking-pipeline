import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getServerEnv } from "@/lib/env";
import * as schema from "@/lib/db/schema";

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (db) {
    return db;
  }

  const env = getServerEnv();
  pool = new Pool({ connectionString: env.DATABASE_URL });
  db = drizzle({ client: pool, schema });
  return db;
}

export async function closeDbPool() {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
