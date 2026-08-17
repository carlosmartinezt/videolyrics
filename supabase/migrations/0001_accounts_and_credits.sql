-- videolyrics: accounts, credits and unlocks.
--
--   DATABASE_URL="postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres" \
--     PGSSLROOTCERT=scripts/.supabase-ca.pem npm run migrate
--
-- Identity comes from the caller's own JWT, never from an argument.
--
-- The obvious shape for these functions takes a user id and is granted to the
-- service role, which means the server needs a key that can do anything to
-- anyone. This does the opposite: every function reads auth.uid() out of the
-- JWT PostgREST verified, and is granted to `authenticated`. The consequence
-- is that the videolyrics server holds no privileged credential at all — it
-- forwards the signed-in person's own token — and the worst a hostile caller
-- can do by hitting these directly is spend their own credit on their own
-- account, which they are welcome to.

/* ------------------------------- profiles -------------------------------- */

create table if not exists public.profiles (
  id                 uuid primary key references auth.users on delete cascade,
  email              text,
  credits_remaining  integer not null default 5,
  credits_per_period integer not null default 5,
  -- The first day of the month this balance belongs to. Rolled forward lazily
  -- by the functions below rather than by a scheduled job, so there is nothing
  -- to forget to run and nothing to go wrong at midnight.
  period_start       date    not null default date_trunc('month', now())::date,
  created_at         timestamptz not null default now(),

  constraint credits_not_negative check (credits_remaining >= 0)
);

comment on table public.profiles is
  'One row per signed-up person. credits_remaining is only ever written by consume_credit().';

/* -------------------------------- unlocks -------------------------------- */

-- A credit buys a *song*, not a download. Once unlocked, that song can be
-- exported again at any resolution, aspect or template for nothing — which is
-- what stops the counter punishing people for changing their mind, and is how
-- "5 video generations a month" reads to a person.
create table if not exists public.unlocks (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  -- sha256 of the uploaded audio bytes. Audio only, deliberately: fixing a
  -- typo in the lyrics and re-aligning must not cost a second credit.
  song_hash  text not null,
  title      text,
  created_at timestamptz not null default now(),

  unique (user_id, song_hash)
);

create index if not exists unlocks_user_created_idx
  on public.unlocks (user_id, created_at desc);

/* ---------------------------------- RLS ---------------------------------- */

alter table public.profiles enable row level security;
alter table public.unlocks  enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using ((select auth.uid()) = id);

drop policy if exists "read own unlocks" on public.unlocks;
create policy "read own unlocks" on public.unlocks
  for select using ((select auth.uid()) = user_id);

-- No insert, update or delete policies on either table, deliberately. The
-- only writes come from the security-definer functions below.

/* ------------------------- profile on signup ----------------------------- */

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/* ---------------------------- shared helpers ------------------------------ */

-- Make sure the caller has a profile, roll its period if the month turned,
-- and return it locked for update. Split out because both entry points need
-- exactly this and drifting apart would be a quiet accounting bug.
create or replace function public.current_profile(p_lock boolean default false)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id          uuid := auth.uid();
  v_profile     public.profiles%rowtype;
  v_this_period date := date_trunc('month', now())::date;
begin
  if v_id is null then
    return v_profile; -- all-null row; callers test for a null id
  end if;

  if p_lock then
    select * into v_profile from public.profiles where id = v_id for update;
  else
    select * into v_profile from public.profiles where id = v_id;
  end if;

  if not found then
    -- The signup trigger is the normal path; this covers accounts created
    -- before it existed or out of band.
    insert into public.profiles (id, email)
    select v_id, u.email from auth.users u where u.id = v_id
    on conflict (id) do nothing;

    if p_lock then
      select * into v_profile from public.profiles where id = v_id for update;
    else
      select * into v_profile from public.profiles where id = v_id;
    end if;
  end if;

  if v_profile.period_start is not null and v_profile.period_start < v_this_period then
    update public.profiles
       set credits_remaining = credits_per_period,
           period_start      = v_this_period
     where id = v_id
    returning * into v_profile;
  end if;

  return v_profile;
end;
$$;

/* ------------------------------ the ledger ------------------------------- */

-- Spend one credit to unlock a song, atomically and idempotently.
--
-- Idempotency matters more than it looks: the export button is in a browser,
-- on a flaky connection, next to a person who will click it twice. Asking for
-- a song you already own returns the same answer and costs nothing.
create or replace function public.consume_credit(
  p_song_hash text,
  p_title     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_already boolean;
begin
  if coalesce(p_song_hash, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- Locked: two export clicks racing must not both read 1 credit and both
  -- decrement it.
  v_profile := public.current_profile(true);
  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;

  select exists (
    select 1 from public.unlocks
     where user_id = v_profile.id and song_hash = p_song_hash
  ) into v_already;

  if v_already then
    return jsonb_build_object(
      'ok', true, 'already', true,
      'remaining', v_profile.credits_remaining,
      'resets_at', (v_profile.period_start + interval '1 month')
    );
  end if;

  if v_profile.credits_remaining <= 0 then
    return jsonb_build_object(
      'ok', false, 'reason', 'no_credits', 'remaining', 0,
      'resets_at', (v_profile.period_start + interval '1 month')
    );
  end if;

  update public.profiles
     set credits_remaining = credits_remaining - 1
   where id = v_profile.id
  returning * into v_profile;

  insert into public.unlocks (user_id, song_hash, title)
  values (v_profile.id, p_song_hash, nullif(left(coalesce(p_title, ''), 120), ''))
  on conflict (user_id, song_hash) do nothing;

  return jsonb_build_object(
    'ok', true, 'already', false,
    'remaining', v_profile.credits_remaining,
    'resets_at', (v_profile.period_start + interval '1 month')
  );
end;
$$;

-- The caller's account, with the period rolled first so a balance shown on
-- the 1st of the month is the new one and not last month's leftovers.
create or replace function public.account_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  v_profile := public.current_profile(false);
  if v_profile.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;

  return jsonb_build_object(
    'ok', true,
    'email', v_profile.email,
    'remaining', v_profile.credits_remaining,
    'per_period', v_profile.credits_per_period,
    'resets_at', (v_profile.period_start + interval '1 month'),
    'unlocked', (select count(*) from public.unlocks where user_id = v_profile.id)
  );
end;
$$;

/* ------------------------------- grants ---------------------------------- */

-- Signed-in callers only, and each is confined to their own row by auth.uid().
-- current_profile is an internal helper and is reachable by nobody.
revoke all on function public.current_profile(boolean)        from public, anon, authenticated;
revoke all on function public.consume_credit(text, text)      from public, anon;
revoke all on function public.account_state()                 from public, anon;
grant execute on function public.consume_credit(text, text)   to authenticated;
grant execute on function public.account_state()              to authenticated;

/* -------------------------- raising limits later -------------------------- */

-- When paid tiers arrive, this is the whole change for one person:
--   update public.profiles
--      set credits_per_period = 50, credits_remaining = 50
--    where email = 'someone@example.com';
