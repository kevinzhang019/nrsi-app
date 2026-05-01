// One-shot migration runner. Reads supabase/migrations/*.sql in order and
// applies each statement against POSTGRES_URL_NON_POOLING (the direct
// non-pooled connection — required for DDL on Supabase Marketplace).
//
// Usage: node --env-file=.env.local scripts/migrate.mjs
//
// Idempotent: every migration in this repo is "create … if not exists",
// so running this twice is safe.

import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "supabase", "migrations");

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!url) {
  console.error("Missing POSTGRES_URL_NON_POOLING / POSTGRES_URL — run `vercel env pull --environment=production .env.local` first.");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1 });

try {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.log("No migrations found.");
    process.exit(0);
  }
  for (const file of files) {
    const path = join(migrationsDir, file);
    const text = await readFile(path, "utf8");
    process.stdout.write(`→ applying ${file} ... `);
    await sql.unsafe(text);
    console.log("ok");
  }
  console.log("\nDone.");
} catch (err) {
  console.error("\nMigration failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
