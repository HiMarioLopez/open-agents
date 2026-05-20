import { drizzle } from "drizzle-orm/postgres-js";
import { createPostgresClient } from "./postgres";
import * as schema from "./schema";

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DrizzleClient | null = null;

export const db = new Proxy({} as DrizzleClient, {
  get(_, prop) {
    if (!_db) {
      const client = createPostgresClient();
      _db = drizzle(client, { schema });
    }
    return Reflect.get(_db, prop);
  },
});
