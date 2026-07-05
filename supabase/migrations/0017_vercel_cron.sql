-- =============================================================================
-- Migración 0017 — Procesamiento asíncrono sin BullMQ (Vercel + Cron)
--
--   Sustituimos las colas de BullMQ/Redis por un modelo dirigido por BD que un
--   cron de Vercel drena cada minuto. Esto permite desplegar TODO en Vercel
--   (funciones serverless), sin procesos worker siempre encendidos.
--
--   1. `conversations.respond_after`: momento a partir del cual el bot puede
--      responder (debounce). Cada mensaje nuevo del lead lo empuja hacia
--      adelante; el cron solo procesa cuando now() >= respond_after.
--   2. `conversations.responding_lock_at`: lock de respuesta (una sola a la vez
--      por conversación). Se reclama si queda obsoleto (> 3 min).
--   3. `outbox`: cola de primeros mensajes proactivos (throttling en el tiempo),
--      que antes vivía en Redis. El cron envía los que ya están vencidos.
-- =============================================================================

-- 1) Debounce + lock de respuesta ----------------------------------------------
alter table public.conversations
  add column if not exists respond_after       timestamptz,
  add column if not exists responding_lock_at  timestamptz;

-- Índice para que el cron encuentre rápido las conversaciones "vencidas".
create index if not exists conversations_respond_after_idx
  on public.conversations (respond_after)
  where respond_after is not null;

-- 2) Outbox de mensajes proactivos (primer contacto, con throttling) -----------
create table if not exists public.outbox (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  kind             text not null default 'proactive',   -- proactive | reply
  transport        text,
  account_id       text,
  attendee_id      text,
  chat_id          text,
  content          text not null,
  send_after       timestamptz not null default now(),   -- no enviar antes de esto
  sent_at          timestamptz,                            -- null = pendiente
  locked_at        timestamptz,                            -- lock de envío (stale > 3 min)
  attempts         integer not null default 0,
  last_error       text,
  created_at       timestamptz not null default now()
);

-- El cron busca lo pendiente y vencido ordenado por send_after.
create index if not exists outbox_pending_idx
  on public.outbox (send_after)
  where sent_at is null;

create index if not exists outbox_org_idx
  on public.outbox (organization_id, send_after);

alter table public.outbox enable row level security;

-- Solo el backend (service role) escribe/lee; los miembros pueden ver la suya.
drop policy if exists "outbox_select_member" on public.outbox;
create policy "outbox_select_member"
  on public.outbox for select
  using (organization_id in (select public.user_org_ids()));
