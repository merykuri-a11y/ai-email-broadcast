import { execFileSync } from "node:child_process";
import postgres from "postgres";
import "./env";

/**
 * Tests run against a real Postgres database.
 *
 * The behaviour that matters most — atomic claiming with SKIP LOCKED,
 * ON CONFLICT DO NOTHING, rolling-window counting — belongs to the database.
 * Mocking it would test the mock rather than the guarantee.
 */
export default async function setup() {
  await ensureTestDatabase();
  // shell: true so this resolves on Windows, where "npx" is really "npx.cmd"
  // and execFileSync won't find it via PATH otherwise. Safe here: the
  // argument list is fixed, never derived from external input.
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], { stdio: "inherit", env: { ...process.env }, shell: true });
}

/** Creates the test database if it does not exist, so a fresh clone just works. */
async function ensureTestDatabase(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL as string);
  const name = url.pathname.slice(1);

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";

  const admin = postgres(adminUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (existing.length === 0) {
      // Database names cannot be parameterized; the name comes from our own
      // DATABASE_URL, and is quoted defensively.
      await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.log(`Created test database "${name}".`);
    }
  } catch (error) {
    throw new Error(
      `Could not prepare the test database "${name}". Is Postgres running? ` +
        `Try: docker compose up -d db\n${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await admin.end();
  }
}
