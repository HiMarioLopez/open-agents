import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createPostgresClient } from "./postgres";

const MIGRATIONS_FOLDER = "./lib/db/migrations";
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_LOCK_KEY = [598_911_645, 461_437_224] as const;

const LEGACY_IGNORABLE_ERROR_CODES = new Set([
  "42P01", // undefined_table
  "42P06", // duplicate_schema
  "42P07", // duplicate_table / duplicate_relation
  "42701", // duplicate_column
  "42703", // undefined_column
  "42710", // duplicate_object
]);

type MigrationFile = {
  sql: string[];
  bps: boolean;
  folderMillis: number;
  hash: string;
};

type ErrorWithCause = {
  code?: string;
  constraint_name?: string;
  detail?: string;
  message?: string;
  cause?: unknown;
};

const client = createPostgresClient({ max: 1 });
const db = drizzle(client);
let migrationFailed = false;
let migrationsLockAcquired = false;

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const current = error as ErrorWithCause;
  if (typeof current.code === "string") {
    return current.code;
  }

  return getErrorCode(current.cause);
}

function getErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  const current = error as ErrorWithCause;
  if (typeof current.message === "string") {
    return current.message;
  }

  if (current.cause) {
    return getErrorMessage(current.cause);
  }

  return "Unknown database error";
}

function getErrorDetail(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const current = error as ErrorWithCause;
  if (typeof current.detail === "string") {
    return current.detail;
  }

  return getErrorDetail(current.cause);
}

function getErrorConstraintName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const current = error as ErrorWithCause;
  if (typeof current.constraint_name === "string") {
    return current.constraint_name;
  }

  return getErrorConstraintName(current.cause);
}

function isIgnorableLegacyError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code ? LEGACY_IGNORABLE_ERROR_CODES.has(code) : false;
}

function isConcurrentBootstrapAlreadyExistsError(error: unknown): boolean {
  if (getErrorCode(error) !== "23505") {
    return false;
  }

  const detail = getErrorDetail(error);
  const constraintName = getErrorConstraintName(error);

  return (
    constraintName === "pg_namespace_nspname_index" &&
    detail === `Key (nspname)=(${MIGRATIONS_SCHEMA}) already exists.`
  );
}

async function acquireMigrationsLock(): Promise<void> {
  await client.unsafe("SELECT pg_advisory_lock($1, $2)", [
    ...MIGRATIONS_LOCK_KEY,
  ]);
  migrationsLockAcquired = true;
}

async function releaseMigrationsLock(): Promise<void> {
  if (!migrationsLockAcquired) {
    return;
  }

  await client.unsafe("SELECT pg_advisory_unlock($1, $2)", [
    ...MIGRATIONS_LOCK_KEY,
  ]);
  migrationsLockAcquired = false;
}

async function ensureMigrationsTable(): Promise<void> {
  try {
    await client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
  } catch (error) {
    if (!isConcurrentBootstrapAlreadyExistsError(error)) {
      throw error;
    }

    console.log(
      `Skipping concurrent migration schema creation race: ${getErrorMessage(error)}`,
    );
  }

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

async function hasRecordedMigrations(): Promise<boolean> {
  const rows = await client.unsafe(`
    SELECT 1
    FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"
    LIMIT 1
  `);

  return rows.length > 0;
}

async function hasLegacySchemaWithoutHistory(): Promise<boolean> {
  const rows = (await client.unsafe(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'accounts'
    ) AS has_accounts
  `)) as Array<{ has_accounts?: boolean }>;

  return rows[0]?.has_accounts === true;
}

async function reconcileLegacySchema(): Promise<void> {
  console.log(
    "Detected existing schema without migration history. Reconciling migration records…",
  );

  const migrations = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  }) as MigrationFile[];

  for (const migration of migrations) {
    for (const statement of migration.sql) {
      const sql = statement.trim();
      if (!sql) {
        continue;
      }

      try {
        await client.unsafe(sql);
      } catch (error) {
        if (isIgnorableLegacyError(error)) {
          console.log(
            `Skipping already-applied statement (${getErrorCode(error)}): ${getErrorMessage(error)}`,
          );
          continue;
        }

        throw error;
      }
    }

    await client.unsafe(
      `
        INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ("hash", "created_at")
        SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" WHERE created_at = $2
        )
      `,
      [migration.hash, migration.folderMillis],
    );
  }

  console.log("Legacy migration reconciliation complete");
}

try {
  await acquireMigrationsLock();
  await ensureMigrationsTable();

  const migrationsRecorded = await hasRecordedMigrations();
  if (!migrationsRecorded && (await hasLegacySchemaWithoutHistory())) {
    await reconcileLegacySchema();
  }

  console.log("Running database migrations…");
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Migrations applied successfully");
} catch (error) {
  console.error("Migration failed:", error);
  migrationFailed = true;
} finally {
  try {
    await releaseMigrationsLock();
  } finally {
    await client.end();
  }
}

if (migrationFailed) {
  process.exit(1);
}
