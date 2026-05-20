import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import postgres from "postgres";

type PostgresOptions = postgres.Options<Record<string, postgres.PostgresType>>;
type PostgresClientOptions = Pick<PostgresOptions, "max">;

const AWS_POSTGRES_REQUIRED_ENV_KEYS = [
  "POSTGRES_AWS_REGION",
  "POSTGRES_AWS_ROLE_ARN",
  "POSTGRES_PGDATABASE",
  "POSTGRES_PGHOST",
  "POSTGRES_PGUSER",
] as const;

type AwsPostgresRequiredEnvKey =
  (typeof AWS_POSTGRES_REQUIRED_ENV_KEYS)[number];

function hasAwsPostgresEnv(): boolean {
  return AWS_POSTGRES_REQUIRED_ENV_KEYS.some((key) => process.env[key]);
}

function getMissingAwsPostgresEnvKeys(): AwsPostgresRequiredEnvKey[] {
  return AWS_POSTGRES_REQUIRED_ENV_KEYS.filter((key) => !process.env[key]);
}

function readEnv(key: AwsPostgresRequiredEnvKey): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required AWS Postgres environment variable: ${key}`,
    );
  }
  return value;
}

function parsePostgresPort(): number {
  const rawPort = process.env.POSTGRES_PGPORT ?? "5432";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid POSTGRES_PGPORT value: ${rawPort}`);
  }

  return port;
}

function parsePostgresSslMode(): PostgresOptions["ssl"] {
  const sslMode = (process.env.POSTGRES_PGSSLMODE ?? "require").toLowerCase();

  switch (sslMode) {
    case "disable":
      return false;
    case "allow":
    case "prefer":
    case "require":
    case "verify-full":
      return sslMode;
    case "verify-ca":
      return { rejectUnauthorized: true };
    case "no-verify":
      return { rejectUnauthorized: false };
    default:
      throw new Error(`Unsupported POSTGRES_PGSSLMODE value: ${sslMode}`);
  }
}

function createAwsPostgresOptions(): PostgresOptions {
  const missingKeys = getMissingAwsPostgresEnvKeys();
  if (missingKeys.length > 0) {
    throw new Error(
      `POSTGRES_URL is not set and AWS Postgres environment variables are incomplete. Missing: ${missingKeys.join(", ")}`,
    );
  }

  const region = readEnv("POSTGRES_AWS_REGION");
  const roleArn = readEnv("POSTGRES_AWS_ROLE_ARN");
  const host = readEnv("POSTGRES_PGHOST");
  const username = readEnv("POSTGRES_PGUSER");
  const port = parsePostgresPort();

  const signer = new Signer({
    credentials: awsCredentialsProvider({
      roleArn,
      clientConfig: { region },
    }),
    hostname: host,
    port,
    region,
    username,
  });

  return {
    database: readEnv("POSTGRES_PGDATABASE"),
    host,
    password: () => signer.getAuthToken(),
    port,
    ssl: parsePostgresSslMode(),
    username,
  };
}

export function createPostgresClient(
  options: PostgresClientOptions = {},
): postgres.Sql {
  if (process.env.POSTGRES_URL) {
    return postgres(process.env.POSTGRES_URL, options);
  }

  if (!hasAwsPostgresEnv()) {
    throw new Error(
      "POSTGRES_URL environment variable is required unless the Vercel AWS Postgres integration variables are configured.",
    );
  }

  return postgres({
    ...createAwsPostgresOptions(),
    ...options,
  });
}
