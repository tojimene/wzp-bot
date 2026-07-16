-- =============================================================================
-- Migración 0021 — Etiquetas (tags) con auto-etiquetado por IA
--
--   Sistema de etiquetas EDITABLE por organización. La IA analiza cada
--   conversación y aplica las etiquetas cuyo criterio se cumple. Reglas:
--     - Varias etiquetas por conversación (M:N).
--     - La IA SOLO añade; nunca quita. Respeta lo manual: si un humano quitó
--       una etiqueta, se registra en `conversation_tag_removals` y la IA no la
--       vuelve a poner.
--     - Cada etiqueta puede, opcionalmente, mover la ETAPA del funnel al
--       aplicarse (`set_stage`).
--
--     - `tag_definitions`          : catálogo de etiquetas por organización.
--     - `conversation_tags`        : etiquetas aplicadas a cada conversación.
--     - `conversation_tag_removals`: etiquetas que un humano quitó (la IA no
--                                    las re-aplica).
-- =============================================================================

-- 1) Catálogo de etiquetas por organización -------------------------------------
create table if not exists public.tag_definitions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  name               text not null,
  color              text not null default '#6366f1',
  -- Criterio en lenguaje natural: CUÁNDO debe aplicar la IA esta etiqueta.
  description        text,
  -- Si se define, aplicar esta etiqueta mueve la conversación a esta etapa.
  set_stage          public.funnel_stage,
  -- Si la IA puede aplicarla automáticamente (si false, solo manual).
  ai_enabled         boolean not null default true,
  sort_order         int not null default 0,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists tag_definitions_org_idx
  on public.tag_definitions (organization_id, sort_order, created_at);
-- Nombre único por organización (case-insensitive).
create unique index if not exists tag_definitions_org_name_uq
  on public.tag_definitions (organization_id, lower(name));

alter table public.tag_definitions enable row level security;

drop policy if exists "tag_definitions_select_member" on public.tag_definitions;
create policy "tag_definitions_select_member"
  on public.tag_definitions for select
  using (organization_id in (select public.user_org_ids()));

drop policy if exists "tag_definitions_all_member" on public.tag_definitions;
create policy "tag_definitions_all_member"
  on public.tag_definitions for all
  using (organization_id in (select public.user_org_ids()))
  with check (organization_id in (select public.user_org_ids()));

-- 2) Etiquetas aplicadas a cada conversación (M:N) ------------------------------
create table if not exists public.conversation_tags (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  tag_id           uuid not null references public.tag_definitions (id) on delete cascade,
  -- 'ai' = la puso el auto-etiquetado; 'human' = la puso una persona.
  source           text not null default 'ai',
  created_by       uuid,
  created_at       timestamptz not null default now()
);

create index if not exists conversation_tags_conv_idx
  on public.conversation_tags (conversation_id);
create index if not exists conversation_tags_tag_idx
  on public.conversation_tags (tag_id);
create unique index if not exists conversation_tags_uq
  on public.conversation_tags (conversation_id, tag_id);

alter table public.conversation_tags enable row level security;

drop policy if exists "conversation_tags_select_member" on public.conversation_tags;
create policy "conversation_tags_select_member"
  on public.conversation_tags for select
  using (organization_id in (select public.user_org_ids()));

drop policy if exists "conversation_tags_all_member" on public.conversation_tags;
create policy "conversation_tags_all_member"
  on public.conversation_tags for all
  using (organization_id in (select public.user_org_ids()))
  with check (organization_id in (select public.user_org_ids()));

-- 3) Etiquetas que un humano quitó (la IA no las re-aplica) ----------------------
create table if not exists public.conversation_tag_removals (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  tag_id           uuid not null references public.tag_definitions (id) on delete cascade,
  created_by       uuid,
  created_at       timestamptz not null default now()
);

create unique index if not exists conversation_tag_removals_uq
  on public.conversation_tag_removals (conversation_id, tag_id);

alter table public.conversation_tag_removals enable row level security;

drop policy if exists "conversation_tag_removals_select_member" on public.conversation_tag_removals;
create policy "conversation_tag_removals_select_member"
  on public.conversation_tag_removals for select
  using (organization_id in (select public.user_org_ids()));

drop policy if exists "conversation_tag_removals_all_member" on public.conversation_tag_removals;
create policy "conversation_tag_removals_all_member"
  on public.conversation_tag_removals for all
  using (organization_id in (select public.user_org_ids()))
  with check (organization_id in (select public.user_org_ids()));

-- 4) Marca de debounce del auto-etiquetado --------------------------------------
alter table public.conversations
  add column if not exists tagged_at timestamptz;
