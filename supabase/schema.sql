-- Trello Lite: таблицы, защита данных и живые обновления.
-- Выполните один раз: Supabase → SQL Editor → New query → вставить весь файл → Run.
-- Повторный запуск безопасен: данные не удаляются, недостающее — досоздаётся.

-- Доски. У каждого пользователя их может быть несколько.
create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  position double precision not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.columns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  board_id uuid references public.boards (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  position double precision not null,
  created_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  column_id uuid not null references public.columns (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  description text not null default '' check (char_length(description) <= 200000),
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  position double precision not null,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Обновление уже созданной базы: описание с форматированием длиннее, и у карточек есть вложения.
alter table public.cards add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.cards drop constraint if exists cards_description_check;
alter table public.cards add constraint cards_description_check check (char_length(description) <= 200000);

-- Обновление уже созданной базы: колонки принадлежат доске.
-- Колонки, созданные до появления досок, переезжают в доску «Моя доска».
alter table public.columns add column if not exists board_id uuid references public.boards (id) on delete cascade;

insert into public.boards (user_id, title, position)
select distinct c.user_id, 'Моя доска', 1024
from public.columns c
where c.board_id is null
  and not exists (select 1 from public.boards b where b.user_id = c.user_id);

update public.columns c
set board_id = (
  select b.id from public.boards b
  where b.user_id = c.user_id
  order by b.position, b.created_at
  limit 1
)
where c.board_id is null;

alter table public.columns alter column board_id set not null;

create index if not exists boards_user_idx on public.boards (user_id);
create index if not exists columns_user_idx on public.columns (user_id);
create index if not exists columns_board_idx on public.columns (board_id);
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

-- Каждый пользователь видит и меняет только свои доски, колонки и карточки.
alter table public.boards enable row level security;
alter table public.columns enable row level security;
alter table public.cards enable row level security;

drop policy if exists "own boards" on public.boards;
create policy "own boards" on public.boards
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own columns" on public.columns;
create policy "own columns" on public.columns
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.boards b where b.id = board_id and b.user_id = (select auth.uid()))
  );

drop policy if exists "own cards" on public.cards;
create policy "own cards" on public.cards
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.columns c where c.id = column_id and c.user_id = (select auth.uid()))
  );

-- Хранилище файлов-вложений. Закрытое: файл доступен только владельцу.
-- Файлы лежат в папке <id пользователя>/<id карточки>/…, до 50 МБ каждый.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "own attachments read" on storage.objects;
create policy "own attachments read" on storage.objects
  for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own attachments upload" on storage.objects;
create policy "own attachments upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own attachments update" on storage.objects;
create policy "own attachments update" on storage.objects
  for update to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own attachments delete" on storage.objects;
create policy "own attachments delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Живые обновления: изменения сразу приходят на все открытые устройства.
do $$
declare
  t text;
begin
  foreach t in array array['boards', 'columns', 'cards'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
