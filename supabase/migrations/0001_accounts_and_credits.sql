-- videolyrics: accounts, credits and unlocks.
--
-- Run against a NEW Supabase project (not the journal one):
--   supabase db push
-- or paste into the SQL editor.
--
-- The shape follows one rule: the browser may *read* a person's own state and
-- may never *write* it. Every mutation goes through consume_credit(), which is
-- granted to the service role only — so the only thing that can spend a credit
-- is the videolyrics API, after it has verified the caller's token.

/* ------------------------------- profiles -------------------------------- */

create table if not exists public.profiles (
  id                 uuid primary key references auth.users on delete cascade,
  email              text,
  credits_remaining  integer not null default 5,
  credits_per_period integer not null default 5,
  -- The first day of the month this balance belongs to. Rolled forward
  -- lazily by consume_credit rather than by a scheduled job, so there is
  -- nothing to forget to run and nothing to go wrong at midnight.
  period_start       date    not null default date_trunc('month', now())::date,
  created_at         timestamptz not null default now(),

  constraint credits_not_negative check (credits_remaining >= 0)
);

comment on table public.profiles is
  'One row per signed-up person. credits_remaining is authoritative and is only ever written by consume_credit().';

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
  for select using (auth.uid() = id);

drop policy if exists "read own unlocks" on public.unlocks;
create policy "read own unlocks" on public.unlocks
  for select using (auth.uid() = user_id);

-- No insert/update/delete policies at all. There is deliberately no way for a
-- browser session to write either table, whatever it sends.

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

/* ------------------------------ the ledger ------------------------------- */

-- Spend one credit to unlock a song, atomically and idempotently.
--
-- Idempotent matters more than it looks: the export button is in a browser, on
-- a flaky connection, next to a person who will click it twice. Asking for a
-- song you already own returns the same answer and costs nothing.
create or replace function public.consume_credit(
  p_user_id   uuid,
  p_song_hash text,
  p_title     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile     public.profiles%rowtype;
  v_this_period date := date_trunc('month', now())::date;
  v_already     boolean;
begin
  if p_user_id is null or coalesce(p_song_hash, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- Lock the row for the whole transaction: two export clicks racing must not
  -- both read 1 credit and both decrement it.
  select * into v_profile from public.profiles where id = p_user_id for update;

  if not found then
    -- The signup trigger is the normal path; this covers accounts that
    -- predate it or were created out of band.
    insert into public.profiles (id, email)
    select p_user_id, u.email from auth.users u where u.id = p_user_id
    on conflict (id) do nothing;
    select * into v_profile from public.profiles where id = p_user_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'no_such_user');
    end if;
  end if;

  -- Roll the period forward if this is the first activity of a new month.
  if v_profile.period_start < v_this_period then
    update public.profiles
       set credits_remaining = credits_per_period,
           period_start      = v_this_period
     where id = p_user_id
    returning * into v_profile;
  end if;

  select exists (
    select 1 from public.unlocks
     where user_id = p_user_id and song_hash = p_song_hash
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
   where id = p_user_id
  returning * into v_profile;

  insert into public.unlocks (user_id, song_hash, title)
  values (p_user_id, p_song_hash, nullif(left(coalesce(p_title, ''), 120), ''))
  on conflict (user_id, song_hash) do nothing;

  return jsonb_build_object(
    'ok', true, 'already', false,
    'remaining', v_profile.credits_remaining,
    'resets_at', (v_profile.period_start + interval '1 month')
  );
end;
$$;

-- Read a person's account state, rolling the period first so a balance shown
-- on the 1st of the month is the new one and not last month's leftovers.
create or replace function public.account_state(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile     public.profiles%rowtype;
  v_this_period date := date_trunc('month', now())::date;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_such_user');
  end if;

  if v_profile.period_start < v_this_period then
    update public.profiles
       set credits_remaining = credits_per_period,
           period_start      = v_this_period
     where id = p_user_id
    returning * into v_profile;
  end if;

  return jsonb_build_object(
    'ok', true,
    'email', v_profile.email,
    'remaining', v_profile.credits_remaining,
    'per_period', v_profile.credits_per_period,
    'resets_at', (v_profile.period_start + interval '1 month'),
    'unlocked', (select count(*) from public.unlocks where user_id = p_user_id)
  );
end;
$$;

/* ------------------------------- grants ---------------------------------- */

-- Neither function is reachable from a browser session. Both take a user id
-- as an argument, so leaving them callable by `authenticated` would let any
-- signed-in person spend somebody else's credits.
revoke all on function public.consume_credit(uuid, text, text) from public, anon, authenticated;
revoke all on function public.account_state(uuid)              from public, anon, authenticated;
grant execute on function public.consume_credit(uuid, text, text) to service_role;
grant execute on function public.account_state(uuid)              to service_role;

/* -------------------------- raising limits later -------------------------- */

-- When paid tiers arrive, this is the whole change for one person:
--   update public.profiles set credits_per_period = 50 where email = '…';
-- It takes effect at their next period roll; to apply it immediately:
--   update public.profiles
--      set credits_per_period = 50, credits_remaining = 50 where email = '…';
