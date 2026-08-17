#!/usr/bin/env node
/**
 * DEV/TEST ONLY. Creates (or resets) a pre-confirmed email/password user
 * directly in auth.users + auth.identities so you can sign in without the
 * email-confirmation round-trip. Never use against a shared/prod project.
 *
 * Usage:
 *   DATABASE_URL=... [PGSSLROOTCERT=...] node scripts/create-test-user.mjs \
 *     e2e@example.com 'JournalTest123!'
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const [email, password] = process.argv.slice(2)
if (!email || !password) {
  console.error('Usage: create-test-user.mjs <email> <password>')
  process.exit(1)
}
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('Set DATABASE_URL')
  process.exit(1)
}

const ssl = process.env.PGSSLROOTCERT
  ? { ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true }
  : process.env.PGSSL_NO_VERIFY === '1'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true }

const client = new pg.Client({ connectionString, ssl })

async function main() {
  await client.connect()
  const uid = randomUUID()
  await client.query('delete from auth.users where email = $1', [email])
  await client.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, created_at, updated_at,
       raw_app_meta_data, raw_user_meta_data,
       -- GoTrue scans these as non-null strings; leaving them NULL breaks login.
       confirmation_token, recovery_token, email_change,
       email_change_token_new, email_change_token_current,
       phone_change, phone_change_token, reauthentication_token
     ) values (
       '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
       $2, crypt($3, gen_salt('bf')),
       now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
       '', '', '', '', '', '', '', ''
     )`,
    [uid, email, password],
  )
  const identityData = JSON.stringify({ sub: uid, email, email_verified: true })
  await client.query(
    `insert into auth.identities (
       id, user_id, provider, provider_id, identity_data,
       last_sign_in_at, created_at, updated_at
     ) values (
       gen_random_uuid(), $1::uuid, 'email', $2, $3::jsonb,
       now(), now(), now()
     )`,
    [uid, email, identityData],
  )
  const { rows } = await client.query(
    'select id, email, email_confirmed_at is not null as confirmed from auth.users where email = $1',
    [email],
  )
  console.log('Created test user:', rows[0])
}

main()
  .catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
  .finally(() => client.end())
