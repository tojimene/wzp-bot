import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { AppliedTag, FunnelStage, TagDefinition } from './tags.types';

type UpsertTagInput = {
  name?: string;
  color?: string;
  description?: string | null;
  set_stage?: FunnelStage | null;
  ai_enabled?: boolean;
  sort_order?: number;
};

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  // --- Catálogo de etiquetas (definiciones) ----------------------------------

  async listDefinitions(orgId: string): Promise<TagDefinition[]> {
    const { data, error } = await this.supabase.admin
      .from('tag_definitions')
      .select('*')
      .eq('organization_id', orgId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as TagDefinition[];
  }

  async createDefinition(
    orgId: string,
    userId: string | null,
    input: UpsertTagInput,
  ): Promise<TagDefinition> {
    const { data, error } = await this.supabase.admin
      .from('tag_definitions')
      .insert({
        organization_id: orgId,
        name: (input.name ?? '').trim(),
        color: input.color ?? '#6366f1',
        description: input.description ?? null,
        set_stage: input.set_stage ?? null,
        ai_enabled: input.ai_enabled ?? true,
        sort_order: input.sort_order ?? 0,
        created_by: userId,
      })
      .select('*')
      .single();
    if (error) throw error;
    return data as TagDefinition;
  }

  async updateDefinition(
    orgId: string,
    id: string,
    input: UpsertTagInput,
  ): Promise<TagDefinition> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) update.name = input.name.trim();
    if (input.color !== undefined) update.color = input.color;
    if (input.description !== undefined) update.description = input.description;
    if (input.set_stage !== undefined) update.set_stage = input.set_stage;
    if (input.ai_enabled !== undefined) update.ai_enabled = input.ai_enabled;
    if (input.sort_order !== undefined) update.sort_order = input.sort_order;

    const { data, error } = await this.supabase.admin
      .from('tag_definitions')
      .update(update)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException('Etiqueta no encontrada');
    return data as TagDefinition;
  }

  async removeDefinition(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await this.supabase.admin
      .from('tag_definitions')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId);
    if (error) throw error;
    return { ok: true };
  }

  // --- Etiquetas aplicadas a una conversación --------------------------------

  /** Etiquetas aplicadas a una conversación (con nombre/color para pintar). */
  async tagsForConversation(orgId: string, conversationId: string): Promise<AppliedTag[]> {
    const { data: applied } = await this.supabase.admin
      .from('conversation_tags')
      .select('tag_id, source, created_at')
      .eq('organization_id', orgId)
      .eq('conversation_id', conversationId);
    const rows = applied ?? [];
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.tag_id as string);
    const { data: defs } = await this.supabase.admin
      .from('tag_definitions')
      .select('id, name, color')
      .in('id', ids);
    const byId = new Map((defs ?? []).map((d) => [d.id as string, d]));

    return rows
      .map((r) => {
        const def = byId.get(r.tag_id as string);
        if (!def) return null;
        return {
          tag_id: r.tag_id as string,
          name: def.name as string,
          color: def.color as string,
          source: (r.source as 'ai' | 'human') ?? 'ai',
          created_at: r.created_at as string,
        };
      })
      .filter(Boolean) as AppliedTag[];
  }

  /** Añade una etiqueta manualmente (persona). Levanta cualquier "removal" previa. */
  async addTagManual(
    orgId: string,
    conversationId: string,
    tagId: string,
    userId: string | null,
  ): Promise<AppliedTag[]> {
    await this.assertTagOwned(orgId, tagId);
    // Si un humano la vuelve a poner, deja de estar "suprimida" para la IA.
    await this.supabase.admin
      .from('conversation_tag_removals')
      .delete()
      .eq('conversation_id', conversationId)
      .eq('tag_id', tagId);

    await this.applyTags(orgId, conversationId, [tagId], 'human', userId);
    return this.tagsForConversation(orgId, conversationId);
  }

  /** Quita una etiqueta y la marca como suprimida (la IA no la re-aplicará). */
  async removeTagManual(
    orgId: string,
    conversationId: string,
    tagId: string,
    userId: string | null,
  ): Promise<AppliedTag[]> {
    await this.supabase.admin
      .from('conversation_tags')
      .delete()
      .eq('organization_id', orgId)
      .eq('conversation_id', conversationId)
      .eq('tag_id', tagId);

    // Registrar la supresión para que el auto-etiquetado la respete.
    await this.supabase.admin
      .from('conversation_tag_removals')
      .upsert(
        {
          organization_id: orgId,
          conversation_id: conversationId,
          tag_id: tagId,
          created_by: userId,
        },
        { onConflict: 'conversation_id,tag_id' },
      );

    return this.tagsForConversation(orgId, conversationId);
  }

  // --- Usado por el auto-etiquetado IA ---------------------------------------

  async appliedTagIds(conversationId: string): Promise<Set<string>> {
    const { data } = await this.supabase.admin
      .from('conversation_tags')
      .select('tag_id')
      .eq('conversation_id', conversationId);
    return new Set((data ?? []).map((r) => r.tag_id as string));
  }

  async removedTagIds(conversationId: string): Promise<Set<string>> {
    const { data } = await this.supabase.admin
      .from('conversation_tag_removals')
      .select('tag_id')
      .eq('conversation_id', conversationId);
    return new Set((data ?? []).map((r) => r.tag_id as string));
  }

  /**
   * Aplica una o varias etiquetas a la conversación (inserta si no existen) y,
   * si alguna tiene `set_stage`, mueve la etapa del funnel. No duplica.
   */
  async applyTags(
    orgId: string,
    conversationId: string,
    tagIds: string[],
    source: 'ai' | 'human',
    userId: string | null,
  ): Promise<void> {
    if (tagIds.length === 0) return;

    const rows = tagIds.map((tagId) => ({
      organization_id: orgId,
      conversation_id: conversationId,
      tag_id: tagId,
      source,
      created_by: userId,
    }));
    await this.supabase.admin
      .from('conversation_tags')
      .upsert(rows, { onConflict: 'conversation_id,tag_id', ignoreDuplicates: true });

    // ¿Alguna etiqueta mueve la etapa? Aplicamos la última con set_stage definido.
    const { data: defs } = await this.supabase.admin
      .from('tag_definitions')
      .select('id, set_stage')
      .in('id', tagIds);
    const stage = (defs ?? [])
      .map((d) => d.set_stage as FunnelStage | null)
      .filter(Boolean)
      .pop();
    if (stage) {
      await this.setStage(orgId, conversationId, stage);
    }
  }

  private async setStage(orgId: string, conversationId: string, stage: FunnelStage): Promise<void> {
    await this.supabase.admin
      .from('conversations')
      .update({ stage })
      .eq('id', conversationId)
      .eq('organization_id', orgId);
    // Mantener el CRM sincronizado (espejo de leads.status).
    await this.supabase.admin
      .from('leads')
      .update({ status: stage })
      .eq('organization_id', orgId)
      .eq('conversation_id', conversationId);
  }

  private async assertTagOwned(orgId: string, tagId: string): Promise<void> {
    const { data } = await this.supabase.admin
      .from('tag_definitions')
      .select('id')
      .eq('id', tagId)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Etiqueta no encontrada');
  }
}
