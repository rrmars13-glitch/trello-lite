-- Trello Lite: таблицы, защита данных и живые обновления.
-- Выполните один раз: Supabase → SQL Editor → New query → вставить весь файл → Run.
-- Повторный запуск безопасен.

create table if not exists public.columns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  position double precision not null,
  created_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  column_id uuid not null references public.columns (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  description text not null default '' check (char_length(description) <= 10000),
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  position double precision not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists columns_user_idx on public.columns (user_id);
create index if not exists cards_user_idx on public.cards (user_id);
create index if not exists cards_column_idx on public.cards (column_id);

-- Время последнего изменения карточки ставит сама база.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cards_touch_updated_at on public.cards;
create trigger cards_touch_updated_at
  before update on public.cards
  for each row execute function public.touch_updated_at();

-- Каждый пользователь видит и меняет только свои колонки и карточки.
alter table public.columns enable row level security;
alter table public.cards enable row level security;

drop policy if exists "own columns" on public.columns;
create policy "own columns" on public.columns
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own cards" on public.cards;
create policy "own cards" on public.cards
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.columns c where c.id = column_id and c.user_id = (select auth.uid()))
  );

-- Живые обновления: изменения сразу приходят на все открытые устройства.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'columns') then
    alter publication supabase_realtime add table public.columns;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cards') then
    alter publication supabase_realtime add table public.cards;
  end if;
end;
$$;
