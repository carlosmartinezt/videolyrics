#!/usr/bin/env node
/**
 * Idempotent migration runner. Borrowed wholesale from the journal app.
 * Applies every .sql file in supabase/migrations
 * in lexical order against the database in DATABASE_URL, tracking applied files
 * in a `public.schema_migrations` table so re-runs are safe.
 *
 * Usage:
 *   DATABASE_URL="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
 *     node scripts/run-migrations.mjs
 *
 * The connection string / DB password is a SECRET — never commit it. Pass it
 * via the environment (or an untracked .env.migrate) at run time only.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(__dirname, '..', 'supabase', 'migrations')

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('ERROR: set DATABASE_URL to your Supabase Postgres connection string.')
  process.exit(1)
}

// TLS: verify by default. Supabase connections use SSL; if your environment
// lacks Supabase's CA in its trust store you can either (preferred) point
// PGSSLROOTCERT at the downloaded CA cert, or (last resort, dev only) set
// PGSSL_NO_VERIFY=1 to skip verification. We never disable verification
// silently.
function buildSsl() {
  if (process.env.PGSSLROOTCERT) {
    return { ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true }
  }
  if (process.env.PGSSL_NO_VERIFY === '1') {
    console.warn('⚠ TLS verification disabled (PGSSL_NO_VERIFY=1) — dev use only.')
    return { rejectUnauthorized: false }
  }
  return { rejectUnauthorized: true }
}

const client = new pg.Client({
  connectionString,
  ssl: buildSsl(),
})

async function main() {
  await client.connect()
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
    -- Deny all API access (RLS on, no policies). The superuser running this
    -- script bypasses RLS, so migrations still work; PostgREST clients can't
    -- see this table via the anon/authenticated roles.
    alter table public.schema_migrations enable row level security;
  `)

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const { rows } = await client.query(
      'select 1 from public.schema_migrations where filename = $1',
      [file],
    )
    if (rows.length > 0) {
      console.log(`• skip   ${file} (already applied)`)
      continue
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    console.log(`▶ apply  ${file}`)
    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('insert into public.schema_migrations (filename) values ($1)', [file])
      await client.query('commit')
      console.log(`✓ done   ${file}`)
    } catch (err) {
      await client.query('rollback')
      console.error(`✗ failed ${file}:`, err.message)
      throw err
    }
  }

  console.log('\nAll migrations applied.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => client.end())
