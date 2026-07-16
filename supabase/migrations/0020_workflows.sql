-- =============================================================================
-- Migración 0020 — Workflows / Seguimientos (árbol de nodos)
--
--   Sistema visual de automatizaciones: cada workflow es un ÁRBOL de nodos
--   (definición en JSON: nodes + edges) que se dispara por un trigger y ejecuta
--   pasos programados en el tiempo (primer mensaje al entrar el lead, esperas,
--   seguimientos, ramas por respuesta/estado, etc.).
--
--     - `workflows`      : definición del árbol por organización + trigger.
--     - `workflow_runs`  : estado de ejecución POR conversación (en qué nodo
--                          está, cuándo toca el siguiente paso). Lo drena el cron.
--
--   El motor reutiliza la tabla `outbox` (throttling + horario activo) para los
--   envíos reales, y respeta la pausa automática cuando el lead responde.
-- =============================================================================

-- 1) Definición de workflows ----------------------------------------------------
create table if not exists public.workflows (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  name               text not null,
  -- Disparador: 'lead_created' (entra un lead) | 'manual' (se activa a mano) |
  -- 'stage' (al cambiar a un estado, ver trigger_config.stage).
  trigger            text not null default 'lead_created',
  trigger_config     jsonb not null default '{}'::jsonb,
  is_active          boolean not null default false,
  -- Si el lead responde, los seguimientos se pausan. Si vuelve a quedarse en
  -- silencio estas horas, el run se reanuda automáticamente (null = no reanudar).
  resume_after_hours int,
  -- Árbol: { "nodes": [...], "edges": [...] } (formato React Flow).
  definition         jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists workflows_org_idx
  on public.workflows (organization_id, created_at desc);
create index if not exists workflows_trigger_idx
  on public.workflows (organization_id, trigger) where is_active;

alter table public.workflows enable row level security;

drop policy if exists "workflows_select_member" on public.workflows;
create policy "workflows_select_member"
  on public.workflows for select
  using (organization_id in (select public.user_org_ids()));

-- 2) Ejecuciones (estado por conversación) --------------------------------------
create table if not exists public.workflow_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  workflow_id      uuid not null references public.workflows (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  -- active | paused | completed | stopped | failed
  status           text not null default 'active',
  current_node_id  text,
  next_run_at      timestamptz,
  context          jsonb not null default '{}'::jsonb,
  last_error       text,
  locked_at        timestamptz,
  started_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists workflow_runs_due_idx
  on public.workflow_runs (next_run_at) where status = 'active';
create index if not exists workflow_runs_conv_idx
  on public.workflow_runs (conversation_id);
-- Evita duplicar un mismo workflow para la misma conversación mientras esté vivo.
create unique index if not exists workflow_runs_active_uq
  on public.workflow_runs (workflow_id, conversation_id)
  where status in ('active', 'paused');

alter table public.workflow_runs enable row level security;

drop policy if exists "workflow_runs_select_member" on public.workflow_runs;
create policy "workflow_runs_select_member"
  on public.workflow_runs for select
  using (organization_id in (select public.user_org_ids()));
