-- =====================================================================================
-- SCAdmin schema for Supabase.
-- Run ONCE: Supabase dashboard -> SQL Editor -> New query -> paste everything -> Run.
-- Safe to re-run. At the very end it SELECTs your first-run SETUP CODE and INVITE CODE.
-- Also turn OFF: Authentication -> Providers -> Email -> "Confirm email".
-- =====================================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- settings: invite/setup codes. RLS on, no policies -> only the functions below can read it ----------
create table if not exists public.settings (key text primary key, value text not null);
alter table public.settings enable row level security;
insert into public.settings (key, value) values
  ('setup_code',  substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
  ('invite_code', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
on conflict (key) do nothing;

-- ---------- tables ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 3 and 24),
  login_email text not null,
  email text not null default '',
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  status text not null default 'active' check (status in ('active', 'suspended', 'banned')),
  ban jsonb,
  team text not null default '',
  dob text not null default '',
  country text not null default '',
  language text not null default 'English',
  bio text not null default '',
  color text not null default '#888888',
  member_since timestamptz not null default now(),
  email_changed timestamptz not null default now(),
  password_changed timestamptz not null default now(),
  last_login timestamptz,
  login_count int not null default 0,
  login_history jsonb not null default '[]',
  email_history jsonb not null default '[]',
  linked jsonb not null default '[]',
  games jsonb not null default '[]',
  stats jsonb not null default '{}'
);
create unique index if not exists profiles_nick_ci on public.profiles (lower(nickname));

create table if not exists public.admin_notes (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  notes text not null default ''
);

create table if not exists public.logs (
  id bigint generated always as identity primary key,
  user_id uuid,
  category text not null,
  action text not null,
  detail text not null default '',
  by_name text not null default 'system',
  at timestamptz not null default now()
);
create index if not exists logs_user_at on public.logs (user_id, at desc);

create table if not exists public.flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  by_name text not null,
  at timestamptz not null default now(),
  status text not null default 'open',
  resolved_by text,
  resolved_at timestamptz,
  resolution text
);

create table if not exists public.saves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  game text not null default 'Other',
  name text not null,
  size bigint not null default 0,
  path text not null,
  uploaded_at timestamptz not null default now(),
  by_name text not null default ''
);

create table if not exists public.crews (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 40),
  tag text not null default '',
  description text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists crews_name_ci on public.crews (lower(name));

create table if not exists public.crew_members (
  crew_id uuid not null references public.crews (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rank text not null default 'Muscle' check (rank in ('Leader', 'Commissioner', 'Lieutenant', 'Representative', 'Muscle')),
  joined_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  topic text not null default '',
  kind text not null default 'channel' check (kind in ('channel', 'dm')),
  private boolean not null default false,
  created_at timestamptz not null default now(),
  created_by text not null default 'system'
);

create table if not exists public.channel_members (
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (channel_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  text text not null default '' check (char_length(text) <= 4000),
  at timestamptz not null default now(),
  edited_at timestamptz,
  file jsonb
);
create index if not exists messages_channel_at on public.messages (channel_id, at);

create table if not exists public.chat_reads (
  user_id uuid not null references public.profiles (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, channel_id)
);

insert into public.channels (name, topic)
select v.n, v.t from (values
  ('general', 'Everyone'), ('dev', 'Developers'), ('testers', 'Testers and QA'),
  ('bugs', 'Bug reports and repro steps'), ('builds', 'Builds, mods and files')) as v (n, t)
where not exists (select 1 from public.channels);

-- ---------- helper functions (used by policies) ----------
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('owner', 'admin') and status = 'active') $$;
create or replace function public.is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner' and status = 'active') $$;
create or replace function public.is_active() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'active') $$;
create or replace function public.my_nick() returns text language sql stable security definer set search_path = public as $$
  select nickname from profiles where id = auth.uid() $$;
create or replace function public.is_crew_member(c uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from crew_members where crew_id = c and user_id = auth.uid()) $$;
create or replace function public.is_crew_leader(c uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from crew_members where crew_id = c and user_id = auth.uid() and rank = 'Leader') $$;
create or replace function public.can_see_channel(c uuid) returns boolean language sql stable security definer set search_path = public as $$
  select is_active() and exists (
    select 1 from channels ch where ch.id = c and (
      (ch.kind = 'channel' and not ch.private)
      or exists (select 1 from channel_members m where m.channel_id = ch.id and m.user_id = auth.uid()))) $$;
create or replace function public.sca_can_access(p_path text) returns boolean language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_path, '/');
begin
  if parts[1] = 'saves' and parts[2] ~ '^[0-9a-f-]{36}$' then
    return is_active() and (is_admin() or parts[2] = auth.uid()::text);
  elsif parts[1] = 'chat' and parts[2] ~ '^[0-9a-f-]{36}$' then
    return can_see_channel(parts[2]::uuid);
  end if;
  return false;
end $$;

-- internal logging (not callable by clients)
create or replace function public.add_log(p_user uuid, p_cat text, p_action text, p_detail text default '') returns void
language sql security definer set search_path = public as $$
  insert into logs (user_id, category, action, detail, by_name) values (p_user, p_cat, p_action, coalesce(p_detail, ''), coalesce(my_nick(), 'system')) $$;

create or replace function public.kill_sessions(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  begin delete from auth.refresh_tokens where user_id = p_user::text; exception when others then null; end;
  begin delete from auth.sessions where user_id = p_user; exception when others then null; end;
end $$;

-- ---------- sign-up: validated, creates the profile ----------
create or replace function public.needs_setup() returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles) $$;

create or replace function public.login_email(nick text) returns text language sql stable security definer set search_path = public as $$
  select login_email from profiles where lower(nickname) = lower(trim(nick)) $$;

create or replace function public.check_signup(nick text, code text) returns text language plpgsql stable security definer set search_path = public as $$
declare n text := trim(coalesce(nick, '')); c text := trim(coalesce(code, ''));
begin
  if char_length(n) < 3 or char_length(n) > 24 then return 'Nickname must be 3-24 characters'; end if;
  if n !~ '^[A-Za-z0-9_.-]+$' then return 'Nickname: letters, numbers and _ . - only'; end if;
  if exists (select 1 from profiles where lower(nickname) = lower(n)) then return 'Nickname already taken'; end if;
  if not exists (select 1 from profiles) then
    if c <> (select value from settings where key = 'setup_code') then return 'Wrong setup code'; end if;
  elsif c <> (select value from settings where key = 'invite_code') then
    return 'Wrong invite code';
  end if;
  return '';
end $$;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); msg text; r text;
begin
  msg := check_signup(m ->> 'nickname', m ->> 'code');
  if msg <> '' then raise exception '%', msg; end if;
  r := case when not exists (select 1 from profiles) then 'owner' else 'member' end;
  insert into profiles (id, nickname, login_email, email, role, color)
  values (new.id, trim(m ->> 'nickname'), new.email, left(coalesce(m ->> 'email', ''), 120), r,
          'hsl(' || (('x' || substr(md5(lower(trim(m ->> 'nickname'))), 1, 4))::bit(16)::int % 360) || ',55%,45%)');
  insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'Account created', r, trim(m ->> 'nickname'));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- profile guards + automatic audit log ----------
create or replace function public.profiles_before_update() returns trigger language plpgsql security definer set search_path = public as $$
declare bypass boolean := coalesce(current_setting('sca.bypass', true), '') = '1'; adm boolean := is_admin();
begin
  if not bypass and auth.uid() is not null then
    if auth.uid() <> old.id and not adm then raise exception 'Not allowed'; end if;
    if new.id <> old.id or new.login_email <> old.login_email or new.member_since <> old.member_since then raise exception 'Not allowed'; end if;
    if new.role <> old.role or new.status <> old.status or new.ban is distinct from old.ban or new.stats is distinct from old.stats then
      raise exception 'Not allowed';
    end if;
    if new.team <> old.team and not adm then raise exception 'Only admins can change the team'; end if;
  end if;
  if new.email <> old.email then
    new.email_history := (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
      select e, n from jsonb_array_elements(jsonb_build_array(jsonb_build_object('email', old.email, 'until', now())) || old.email_history)
        with ordinality as t (e, n) order by n limit 20) q);
    new.email_changed := now();
  end if;
  return new;
end $$;
drop trigger if exists profiles_before_update on public.profiles;
create trigger profiles_before_update before update on public.profiles for each row execute function public.profiles_before_update();

create or replace function public.profiles_after_update() returns trigger language plpgsql security definer set search_path = public as $$
declare who text := coalesce(my_nick(), 'system');
begin
  if new.nickname <> old.nickname then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'nickname', 'Nickname changed', old.nickname || ' -> ' || new.nickname, who); end if;
  if new.email <> old.email then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'email', 'Email changed', old.email || ' -> ' || new.email, who); end if;
  if new.team <> old.team then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'Team changed', coalesce(nullif(old.team, ''), '-') || ' -> ' || coalesce(nullif(new.team, ''), '-'), who); end if;
  if new.dob <> old.dob then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'dob updated', '', who); end if;
  if new.country <> old.country then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'country updated', '', who); end if;
  if new.language <> old.language then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'language updated', '', who); end if;
  if new.bio <> old.bio then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'bio updated', '', who); end if;
  if new.linked is distinct from old.linked then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'Linked accounts updated', '', who); end if;
  if new.games is distinct from old.games then insert into logs (user_id, category, action, detail, by_name) values (new.id, 'profile', 'Games updated', jsonb_array_length(new.games) || ' titles', who); end if;
  return new;
end $$;
drop trigger if exists profiles_after_update on public.profiles;
create trigger profiles_after_update after update on public.profiles for each row execute function public.profiles_after_update();

create or replace function public.saves_log() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform add_log(new.user_id, 'profile', 'Cloud save uploaded', new.game || ': ' || new.name); return new;
  else perform add_log(old.user_id, 'profile', 'Cloud save deleted', old.game || ': ' || old.name); return old; end if;
end $$;
drop trigger if exists saves_log_ins on public.saves;
create trigger saves_log_ins after insert on public.saves for each row execute function public.saves_log();
drop trigger if exists saves_log_del on public.saves;
create trigger saves_log_del after delete on public.saves for each row execute function public.saves_log();

create or replace function public.messages_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.channel_id <> old.channel_id or new.user_id <> old.user_id or new.at <> old.at or new.file is distinct from old.file then
    raise exception 'Only the message text can be edited';
  end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before update on public.messages for each row execute function public.messages_guard();

-- ---------- directory (safe public-ish member list for chat) ----------
create or replace view public.directory as select id, nickname, team, color, role, status from public.profiles;

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.admin_notes enable row level security;
alter table public.logs enable row level security;
alter table public.flags enable row level security;
alter table public.saves enable row level security;
alter table public.crews enable row level security;
alter table public.crew_members enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;
alter table public.chat_reads enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using ((id = auth.uid() and is_active()) or is_admin()) with check ((id = auth.uid() and is_active()) or is_admin());

drop policy if exists notes_all on public.admin_notes;
create policy notes_all on public.admin_notes for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists logs_select on public.logs;
create policy logs_select on public.logs for select to authenticated using (user_id = auth.uid() or is_admin());

drop policy if exists flags_select on public.flags;
create policy flags_select on public.flags for select to authenticated using (is_admin());

drop policy if exists saves_select on public.saves;
create policy saves_select on public.saves for select to authenticated using ((user_id = auth.uid() and is_active()) or is_admin());
drop policy if exists saves_insert on public.saves;
create policy saves_insert on public.saves for insert to authenticated with check ((user_id = auth.uid() and is_active()) or is_admin());
drop policy if exists saves_delete on public.saves;
create policy saves_delete on public.saves for delete to authenticated using ((user_id = auth.uid() and is_active()) or is_admin());

drop policy if exists crews_select on public.crews;
create policy crews_select on public.crews for select to authenticated using (is_admin() or is_crew_member(id));
drop policy if exists crews_update on public.crews;
create policy crews_update on public.crews for update to authenticated using (is_admin() or is_crew_leader(id)) with check (is_admin() or is_crew_leader(id));
drop policy if exists crews_delete on public.crews;
create policy crews_delete on public.crews for delete to authenticated using (is_admin() or is_crew_leader(id));
drop policy if exists crew_members_select on public.crew_members;
create policy crew_members_select on public.crew_members for select to authenticated using (is_admin() or is_crew_member(crew_id));

drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels for select to authenticated using (can_see_channel(id));
drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels for delete to authenticated using (is_admin() and kind = 'channel');
drop policy if exists channel_members_select on public.channel_members;
create policy channel_members_select on public.channel_members for select to authenticated using (can_see_channel(channel_id));

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated using (can_see_channel(channel_id));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = auth.uid() and can_see_channel(channel_id) and (char_length(text) > 0 or file is not null));
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (user_id = auth.uid() and can_see_channel(channel_id)) with check (user_id = auth.uid() and char_length(text) > 0);
drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated using (user_id = auth.uid() or is_admin());

drop policy if exists reads_all on public.chat_reads;
create policy reads_all on public.chat_reads for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- storage (private bucket "files": saves/<user>/..., chat/<channel>/...) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 26214400)
on conflict (id) do update set file_size_limit = excluded.file_size_limit, public = false;

drop policy if exists files_select on storage.objects;
create policy files_select on storage.objects for select to authenticated using (bucket_id = 'files' and sca_can_access(name));
drop policy if exists files_insert on storage.objects;
create policy files_insert on storage.objects for insert to authenticated with check (bucket_id = 'files' and sca_can_access(name));
drop policy if exists files_delete on storage.objects;
create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files' and sca_can_access(name) and (is_admin() or coalesce(owner_id, owner::text) = auth.uid()::text));

-- ================================ RPCs (all enforce permissions themselves) ================================
create or replace function public.lift_expired() returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id, status from profiles where status <> 'active' and nullif(ban ->> 'until', '') is not null and (ban ->> 'until')::timestamptz < now() loop
    perform set_config('sca.bypass', '1', true);
    update profiles set status = 'active', ban = null where id = r.id;
    insert into logs (user_id, category, action, detail, by_name)
    values (r.id, 'moderation', case when r.status = 'banned' then 'Ban expired' else 'Suspension expired' end, '', 'system');
  end loop;
end $$;

create or replace function public.record_login(p_ua text default '') returns void language plpgsql security definer set search_path = public as $$
begin
  update profiles set last_login = now(), login_count = login_count + 1,
    login_history = (select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
      select e, n from jsonb_array_elements(jsonb_build_array(jsonb_build_object('at', now(), 'ua', left(coalesce(p_ua, ''), 120))) || login_history)
        with ordinality as t (e, n) order by n limit 30) q)
  where id = auth.uid();
  perform add_log(auth.uid(), 'security', 'Signed in', '');
end $$;

create or replace function public.log_event(p_user uuid, p_cat text, p_action text, p_detail text default '') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or (p_user = auth.uid() and p_cat in ('password', 'profile') and is_active())) then raise exception 'Not allowed'; end if;
  perform add_log(p_user, p_cat, p_action, left(coalesce(p_detail, ''), 300));
end $$;

create or replace function public.get_invite_code() returns text language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return (select value from settings where key = 'invite_code');
end $$;
create or replace function public.rotate_invite_code() returns text language plpgsql security definer set search_path = public as $$
declare c text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update settings set value = c where key = 'invite_code';
  return c;
end $$;

create or replace function public.admin_overview() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  perform lift_expired();
  return jsonb_build_object(
    'members', (select count(*) from profiles),
    'restricted', (select count(*) from profiles where status <> 'active'),
    'hours', (select coalesce(sum(nullif(g ->> 'hours', '')::numeric), 0) from profiles p, jsonb_array_elements(p.games) g),
    'saves', (select count(*) from saves),
    'crews', (select count(*) from crews),
    'openFlags', (select count(*) from flags where status = 'open'),
    'recent', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
      select l.id, l.user_id as "userId", l.category, l.action, l.detail, l.by_name as "by", l.at, coalesce(p.nickname, '(deleted)') as nickname
      from logs l left join profiles p on p.id = l.user_id order by l.at desc, l.id desc limit 15) r));
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text) returns void language plpgsql security definer set search_path = public as $$
declare t profiles;
begin
  if not is_owner() then raise exception 'Owner only'; end if;
  select * into t from profiles where id = p_user;
  if t.id is null then raise exception 'No such member'; end if;
  if t.role = 'owner' or p_role not in ('admin', 'member') then raise exception 'Not allowed'; end if;
  if t.role <> p_role then
    perform set_config('sca.bypass', '1', true);
    update profiles set role = p_role where id = p_user;
    perform add_log(p_user, 'security', 'Role changed', t.role || ' -> ' || p_role);
  end if;
end $$;

create or replace function public.admin_delete_user(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'Owner only'; end if;
  if p_user = auth.uid() then raise exception 'You cannot delete yourself'; end if;
  delete from channels where kind = 'dm' and id in (select channel_id from channel_members where user_id = p_user);
  delete from logs where user_id = p_user;
  delete from auth.users where id = p_user;
  delete from crews c where not exists (select 1 from crew_members m where m.crew_id = c.id);
end $$;

create or replace function public.admin_reset_password(p_user uuid, p_password text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'Password must be 8+ characters'; end if;
  if (select role from profiles where id = p_user) = 'owner' and p_user <> auth.uid() then raise exception 'Only the owner can change the owner password'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now() where id = p_user;
  perform set_config('sca.bypass', '1', true);
  update profiles set password_changed = now() where id = p_user;
  perform kill_sessions(p_user);
  perform add_log(p_user, 'password', 'Password reset by admin', '');
end $$;

create or replace function public.admin_signout(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  perform kill_sessions(p_user);
  perform add_log(p_user, 'security', 'All sessions signed out', '');
end $$;

create or replace function public.admin_moderate(p_user uuid, p_action text, p_reason text default '', p_days int default 0) returns void
language plpgsql security definer set search_path = public as $$
declare t profiles; me profiles; d int; r text := trim(coalesce(p_reason, ''));
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null or me.role not in ('owner', 'admin') or me.status <> 'active' then raise exception 'Admins only'; end if;
  select * into t from profiles where id = p_user;
  if t.id is null then raise exception 'No such member'; end if;
  if t.id = me.id then raise exception 'You cannot moderate yourself'; end if;
  if t.role = 'owner' or (t.role = 'admin' and me.role <> 'owner') then raise exception 'Not allowed on this account'; end if;
  perform set_config('sca.bypass', '1', true);
  if p_action = 'unban' then
    if t.status = 'active' then raise exception 'Account is already active'; end if;
    update profiles set status = 'active', ban = null where id = t.id;
    perform add_log(t.id, 'moderation', 'Restriction lifted', r);
  elsif p_action in ('suspend', 'ban') then
    if char_length(r) < 3 then raise exception 'A reason is required'; end if;
    d := case when p_action = 'suspend' then coalesce(nullif(p_days, 0), 7) else coalesce(p_days, 0) end;
    d := least(greatest(d, 0), 3650);
    update profiles set status = case when p_action = 'ban' then 'banned' else 'suspended' end,
      ban = jsonb_build_object('reason', r, 'by', me.nickname, 'at', now(), 'until', case when d > 0 then now() + make_interval(days => d) else null end)
    where id = t.id;
    perform kill_sessions(t.id);
    perform add_log(t.id, 'moderation', case when p_action = 'ban' then 'Account banned' else 'Account suspended' end,
                    r || ' (' || case when d > 0 then d || ' days' else 'permanent' end || ')');
  else
    raise exception 'Unknown action';
  end if;
end $$;

create or replace function public.admin_set_stats(p_user uuid, p_game text, p_changes jsonb, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  defs jsonb := '{"gtav":{"rank":[1,8000,1],"cash":[0,2147483647,0],"bank":[0,2147483647,0],"kills":[0,2147483647,0],"deaths":[0,2147483647,0],"missions":[0,100000,0],"races":[0,100000,0]},
                  "rdr2":{"rank":[1,999,1],"cash":[0,2147483647,0],"gold":[0,100000,0],"honor":[-1000,1000,0],"kills":[0,2147483647,0],"deaths":[0,2147483647,0],"bounties":[0,100000,0]}}';
  names jsonb := '{"gtav":"Grand Theft Auto V","rdr2":"Red Dead Redemption 2"}';
  labels jsonb := '{"rank":"Rank","cash":"Cash ($)","bank":"Bank ($)","kills":"Kills","deaths":"Deaths","missions":"Missions completed","races":"Races won","gold":"Gold bars","honor":"Honor","bounties":"Bounties collected"}';
  f record; spec jsonb; cur jsonb; v bigint; oldv bigint; r text := trim(coalesce(p_reason, ''));
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if not (defs ? p_game) then raise exception 'Unknown game'; end if;
  if char_length(r) < 3 then raise exception 'A reason is required for stat changes'; end if;
  perform set_config('sca.bypass', '1', true);
  select coalesce(stats -> p_game, '{}'::jsonb) into cur from profiles where id = p_user;
  if cur is null then raise exception 'No such member'; end if;
  for f in select key, value from jsonb_each(coalesce(p_changes, '{}'::jsonb)) loop
    spec := defs -> p_game -> f.key;
    if spec is null then continue; end if;
    v := round((f.value #>> '{}')::numeric)::bigint;
    v := least(greatest(v, (spec ->> 0)::bigint), (spec ->> 1)::bigint);
    oldv := coalesce((cur ->> f.key)::bigint, (spec ->> 2)::bigint);
    if v <> oldv then
      cur := jsonb_set(cur, array[f.key], to_jsonb(v), true);
      perform add_log(p_user, 'stats', (names ->> p_game) || ': ' || (labels ->> f.key) || ' changed', oldv || ' -> ' || v || ' (' || r || ')');
    end if;
  end loop;
  update profiles set stats = jsonb_set(stats, array[p_game], cur, true) where id = p_user;
end $$;

create or replace function public.admin_reset_stats(p_user uuid, p_game text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r text := trim(coalesce(p_reason, ''));
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if char_length(r) < 3 then raise exception 'A reason is required for stat changes'; end if;
  perform set_config('sca.bypass', '1', true);
  update profiles set stats = stats - p_game where id = p_user;
  perform add_log(p_user, 'stats', p_game || ': character progress reset', r);
end $$;

create or replace function public.report_member(p_user uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare r text := trim(coalesce(p_reason, ''));
begin
  if not is_active() then raise exception 'Account is not active'; end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'No such member'; end if;
  if char_length(r) < 3 then raise exception 'Give a reason'; end if;
  insert into flags (user_id, reason, by_name) values (p_user, left(r, 400), my_nick());
  perform add_log(p_user, 'moderation', 'Reported / flagged', left(r, 400));
end $$;

create or replace function public.resolve_flag(p_flag uuid, p_resolution text default '') returns void language plpgsql security definer set search_path = public as $$
declare f flags;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select * into f from flags where id = p_flag;
  if f.id is null then raise exception 'No such flag'; end if;
  update flags set status = 'resolved', resolved_by = my_nick(), resolved_at = now(), resolution = left(coalesce(p_resolution, ''), 300) where id = p_flag;
  perform add_log(f.user_id, 'moderation', 'Flag resolved', left(coalesce(p_resolution, ''), 300));
end $$;

-- ---------- crews ----------
create or replace function public.create_crew(p_name text, p_tag text, p_desc text default '', p_leader uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := trim(coalesce(p_name, '')); tg text := upper(regexp_replace(left(coalesce(p_tag, ''), 4), '[^A-Za-z0-9]', '', 'g')); lead uuid; cid uuid;
begin
  if not is_active() then raise exception 'Account is not active'; end if;
  if char_length(n) < 3 or char_length(n) > 40 then raise exception 'Crew name must be 3-40 characters'; end if;
  if exists (select 1 from crews where lower(name) = lower(n)) then raise exception 'Crew name taken'; end if;
  lead := case when is_admin() and p_leader is not null then p_leader else auth.uid() end;
  if not exists (select 1 from profiles where id = lead) then raise exception 'No such leader'; end if;
  insert into crews (name, tag, description) values (n, tg, left(coalesce(p_desc, ''), 300)) returning id into cid;
  insert into crew_members (crew_id, user_id, rank) values (cid, lead, 'Leader');
  perform add_log(lead, 'profile', 'Crew created', n);
  return cid;
end $$;

create or replace function public.crew_add_member(p_crew uuid, p_nick text, p_rank text default 'Muscle') returns void
language plpgsql security definer set search_path = public as $$
declare t uuid; rk text := case when p_rank in ('Commissioner', 'Lieutenant', 'Representative', 'Muscle') then p_rank else 'Muscle' end;
begin
  if not (is_admin() or is_crew_leader(p_crew)) then raise exception 'Only the crew leader or an admin can do that'; end if;
  select id into t from profiles where lower(nickname) = lower(trim(coalesce(p_nick, ''))) and status = 'active';
  if t is null then raise exception 'No member with that nickname'; end if;
  if exists (select 1 from crew_members where crew_id = p_crew and user_id = t) then raise exception 'Already in this crew'; end if;
  insert into crew_members (crew_id, user_id, rank) values (p_crew, t, rk);
  perform add_log(t, 'profile', 'Joined crew', (select name from crews where id = p_crew));
end $$;

create or replace function public.crew_set_rank(p_crew uuid, p_user uuid, p_rank text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or is_crew_leader(p_crew)) then raise exception 'Only the crew leader or an admin can do that'; end if;
  if p_rank not in ('Commissioner', 'Lieutenant', 'Representative', 'Muscle') then raise exception 'Use "make leader" to change the leader'; end if;
  if (select rank from crew_members where crew_id = p_crew and user_id = p_user) = 'Leader' then raise exception 'Use "make leader" to change the leader'; end if;
  update crew_members set rank = p_rank where crew_id = p_crew and user_id = p_user;
end $$;

create or replace function public.crew_set_leader(p_crew uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or is_crew_leader(p_crew)) then raise exception 'Only the crew leader or an admin can do that'; end if;
  if not exists (select 1 from crew_members where crew_id = p_crew and user_id = p_user) then raise exception 'Not a member of this crew'; end if;
  update crew_members set rank = 'Commissioner' where crew_id = p_crew and rank = 'Leader';
  update crew_members set rank = 'Leader' where crew_id = p_crew and user_id = p_user;
  perform add_log(p_user, 'profile', 'Became crew leader', (select name from crews where id = p_crew));
end $$;

create or replace function public.crew_remove_member(p_crew uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare rk text; cnt int;
begin
  if not (is_admin() or is_crew_leader(p_crew) or p_user = auth.uid()) then raise exception 'Only the crew leader or an admin can do that'; end if;
  select rank into rk from crew_members where crew_id = p_crew and user_id = p_user;
  if rk is null then raise exception 'Not a member'; end if;
  select count(*) into cnt from crew_members where crew_id = p_crew;
  if rk = 'Leader' and cnt > 1 then raise exception 'Transfer leadership first'; end if;
  delete from crew_members where crew_id = p_crew and user_id = p_user;
  perform add_log(p_user, 'profile', 'Left / removed from crew', (select name from crews where id = p_crew));
  if cnt = 1 then delete from crews where id = p_crew; end if;
end $$;

-- ---------- chat ----------
create or replace function public.chat_channels() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'last' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', c.id,
      'name', case when c.kind = 'dm'
                then coalesce((select p.nickname from channel_members m join profiles p on p.id = m.user_id where m.channel_id = c.id and m.user_id <> auth.uid() limit 1), '(deleted)')
                else c.name end,
      'kind', c.kind, 'private', c.private, 'topic', c.topic,
      'members', (select count(*) from channel_members m where m.channel_id = c.id),
      'unread', (select count(*) from messages g where g.channel_id = c.id and g.user_id <> auth.uid()
                  and g.at > coalesce((select read_at from chat_reads r where r.user_id = auth.uid() and r.channel_id = c.id),
                                      (select member_since from profiles where id = auth.uid()))),
      'last', to_char(coalesce((select max(at) from messages g where g.channel_id = c.id), c.created_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) as x
    from channels c where can_see_channel(c.id)) t $$;

create or replace function public.chat_mark_read(p_channel uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_see_channel(p_channel) then return; end if;
  insert into chat_reads (user_id, channel_id, read_at) values (auth.uid(), p_channel, now())
  on conflict (user_id, channel_id) do update set read_at = now();
end $$;

create or replace function public.get_or_create_dm(p_user uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if not is_active() then raise exception 'Account is not active'; end if;
  if p_user = auth.uid() or not exists (select 1 from profiles where id = p_user and status = 'active') then raise exception 'Pick another member'; end if;
  select c.id into cid from channels c
   where c.kind = 'dm'
     and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = auth.uid())
     and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = p_user) limit 1;
  if cid is null then
    insert into channels (kind, private, created_by) values ('dm', true, coalesce(my_nick(), '')) returning id into cid;
    insert into channel_members (channel_id, user_id) values (cid, auth.uid()), (cid, p_user);
  end if;
  return cid;
end $$;

create or replace function public.create_channel(p_name text, p_private boolean default false, p_members text[] default '{}', p_topic text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := regexp_replace(regexp_replace(lower(left(trim(coalesce(p_name, '')), 24)), '[^a-z0-9-]', '-', 'g'), '^-+|-+$', '', 'g'); cid uuid; nick text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if char_length(n) < 2 then raise exception 'Channel name must be 2+ characters (letters, numbers, dashes)'; end if;
  if exists (select 1 from channels where kind = 'channel' and name = n) then raise exception 'Channel already exists'; end if;
  insert into channels (name, topic, kind, private, created_by) values (n, left(coalesce(p_topic, ''), 120), 'channel', coalesce(p_private, false), my_nick()) returning id into cid;
  insert into channel_members (channel_id, user_id) values (cid, auth.uid());
  foreach nick in array coalesce(p_members, '{}') loop
    insert into channel_members (channel_id, user_id)
    select cid, id from profiles where lower(nickname) = lower(trim(nick)) on conflict do nothing;
  end loop;
  return cid;
end $$;

-- ---------- privileges ----------
revoke all on public.directory from anon, public;
grant select on public.directory to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('add_log', 'kill_sessions', 'handle_new_user', 'profiles_before_update', 'profiles_after_update', 'saves_log', 'messages_guard') then
      null; -- internal only
    elsif f.proname in ('needs_setup', 'login_email', 'check_signup') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ============ YOUR CODES (shown in the result grid) ============
select key, value from public.settings order by key;
