import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema.js';

export type AppDatabase = ReturnType<typeof createDb>;

export function createDb(url: string, authToken: string) {
  const client = createClient({ url, authToken });
  return drizzle(client, { schema });
}
