import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { WorkflowDefinition, WorkflowTrigger } from './workflows.types';

const COLS =
  'id, organization_id, name, trigger, trigger_config, is_active, resume_after_hours, definition, created_at, updated_at';

export type WorkflowRow = {
  id: string;
  organization_id: string;
  name: string;
  trigger: WorkflowTrigger;
  trigger_config: Record<string, unknown>;
  is_active: boolean;
  resume_after_hours: number | null;
  definition: WorkflowDefinition;
  created_at: string;
  updated_at: string;
};

@Injectable()
export class WorkflowsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(orgId: string): Promise<WorkflowRow[]> {
    const { data, error } = await this.supabase.admin
      .from('workflows')
      .select(COLS)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as WorkflowRow[];
  }

  async get(orgId: string, id: string): Promise<WorkflowRow> {
    const { data, error } = await this.supabase.admin
      .from('workflows')
      .select(COLS)
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Workflow no encontrado');
    return data as WorkflowRow;
  }

  async create(
    orgId: string,
    userId: string,
    dto: {
      name: string;
      trigger?: WorkflowTrigger;
      trigger_config?: Record<string, unknown>;
      resume_after_hours?: number | null;
      definition?: WorkflowDefinition;
    },
  ): Promise<WorkflowRow> {
    const { data, error } = await this.supabase.admin
      .from('workflows')
      .insert({
        organization_id: orgId,
        name: dto.name,
        trigger: dto.trigger ?? 'lead_created',
        trigger_config: dto.trigger_config ?? {},
        resume_after_hours: dto.resume_after_hours ?? null,
        definition: dto.definition ?? { nodes: [], edges: [] },
        created_by: userId,
      })
      .select(COLS)
      .single();
    if (error) throw error;
    return data as WorkflowRow;
  }

  async update(
    orgId: string,
    id: string,
    patch: {
      name?: string;
      trigger?: WorkflowTrigger;
      trigger_config?: Record<string, unknown>;
      is_active?: boolean;
      resume_after_hours?: number | null;
      definition?: WorkflowDefinition;
    },
  ): Promise<WorkflowRow> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.trigger !== undefined) update.trigger = patch.trigger;
    if (patch.trigger_config !== undefined) update.trigger_config = patch.trigger_config;
    if (patch.is_active !== undefined) update.is_active = patch.is_active;
    if (patch.resume_after_hours !== undefined) update.resume_after_hours = patch.resume_after_hours;
    if (patch.definition !== undefined) update.definition = patch.definition;

    const { data, error } = await this.supabase.admin
      .from('workflows')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select(COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Workflow no encontrado');
    return data as WorkflowRow;
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await this.supabase.admin
      .from('workflows')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id);
    if (error) throw error;
    return { ok: true };
  }

  /** Primer workflow ACTIVO que coincide con el trigger (o null). */
  async findActiveByTrigger(
    orgId: string,
    trigger: WorkflowTrigger,
  ): Promise<WorkflowRow | null> {
    const { data } = await this.supabase.admin
      .from('workflows')
      .select(COLS)
      .eq('organization_id', orgId)
      .eq('trigger', trigger)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as WorkflowRow) ?? null;
  }
}
