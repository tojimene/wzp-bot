import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

/** Datos con los que se registra/actualiza un lead en el CRM. */
export type RecordLeadInput = {
  conversationId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  provider?: string | null;
  source?: string | null;
  sourceDetail?: string | null;
  campaign?: string | null;
  externalId?: string | null;
  firstMessage?: string | null;
  consentOptin?: boolean;
  /** Campos personalizados del formulario (clave/valor). */
  fields?: Record<string, unknown>;
  /** Payload original completo, tal cual llegó. */
  raw?: Record<string, unknown>;
};

export type LeadPatch = {
  status?: string;
  notes?: string;
  name?: string;
  email?: string;
};

const LEAD_COLUMNS =
  'id, organization_id, conversation_id, name, phone, email, provider, source, source_detail, campaign, external_id, status, consent_optin, first_message, fields, raw, notes, created_at, updated_at';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Registra un lead en el CRM (o actualiza el existente). Deduplica por id
   * externo, luego por teléfono, luego por email dentro de la organización.
   * Se llama SIEMPRE que entra un lead, antes de que el bot le escriba.
   */
  async record(orgId: string, input: RecordLeadInput) {
    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    const externalId = input.externalId?.trim() || null;

    const existing = await this.findExisting(orgId, externalId, phone, email);

    if (existing) {
      const update: Record<string, unknown> = {};
      // Solo rellenamos lo que falta o llega nuevo (no pisamos datos buenos).
      if (input.name && (!existing.name || existing.name === 'Lead')) update.name = input.name;
      if (phone && !existing.phone) update.phone = phone;
      if (email && !existing.email) update.email = email;
      if (input.provider && !existing.provider) update.provider = input.provider;
      if (input.source && !existing.source) update.source = input.source;
      if (input.sourceDetail && !existing.source_detail) update.source_detail = input.sourceDetail;
      if (input.campaign && !existing.campaign) update.campaign = input.campaign;
      if (externalId && !existing.external_id) update.external_id = externalId;
      if (input.conversationId && !existing.conversation_id)
        update.conversation_id = input.conversationId;
      if (input.firstMessage && !existing.first_message) update.first_message = input.firstMessage;
      if (input.consentOptin) update.consent_optin = true;
      // Fusionamos payloads: conservamos lo anterior y añadimos lo nuevo.
      if (input.raw && Object.keys(input.raw).length > 0) {
        update.raw = { ...(existing.raw as object | null), ...input.raw };
      }
      if (input.fields && Object.keys(input.fields).length > 0) {
        update.fields = { ...(existing.fields as object | null), ...input.fields };
      }

      if (Object.keys(update).length === 0) return existing;

      const { data, error } = await this.supabase.admin
        .from('leads')
        .update(update)
        .eq('id', existing.id)
        .select(LEAD_COLUMNS)
        .single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await this.supabase.admin
      .from('leads')
      .insert({
        organization_id: orgId,
        conversation_id: input.conversationId ?? null,
        name: input.name ?? null,
        phone,
        email,
        provider: input.provider ?? null,
        source: input.source ?? null,
        source_detail: input.sourceDetail ?? null,
        campaign: input.campaign ?? null,
        external_id: externalId,
        status: 'new',
        consent_optin: input.consentOptin ?? false,
        first_message: input.firstMessage ?? null,
        fields: input.fields ?? {},
        raw: input.raw ?? {},
      })
      .select(LEAD_COLUMNS)
      .single();
    if (error) throw error;
    this.logger.log(`Nuevo lead en CRM (org ${orgId}, source=${input.source ?? 'n/d'})`);
    return data;
  }

  /** Enlaza un lead con su conversación (si aún no lo estaba). */
  async linkConversation(orgId: string, leadId: string, conversationId: string) {
    await this.supabase.admin
      .from('leads')
      .update({ conversation_id: conversationId })
      .eq('id', leadId)
      .eq('organization_id', orgId)
      .is('conversation_id', null);
  }

  /** Mantiene el estado del lead sincronizado con el de su conversación. */
  async syncStatusByConversation(orgId: string, conversationId: string, status: string) {
    await this.supabase.admin
      .from('leads')
      .update({ status })
      .eq('organization_id', orgId)
      .eq('conversation_id', conversationId);
  }

  // --- CRM (autenticado) ------------------------------------------------------

  async list(
    orgId: string,
    filters: { status?: string; source?: string; search?: string } = {},
  ) {
    let query = this.supabase.admin
      .from('leads')
      .select(
        'id, conversation_id, name, phone, email, provider, source, source_detail, campaign, status, created_at',
      )
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(500);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.source) query = query.eq('source', filters.source);
    if (filters.search) {
      // Escapamos los caracteres reservados de la gramática de filtros de
      // PostgREST (`,`, `%`, `(`, `)`, `.`, `"`, `*`, `\`) para que el término de
      // búsqueda no pueda alterar la consulta `.or()` (inyección de filtro).
      const s = filters.search.replace(/[%,()."\\*]/g, ' ').trim();
      if (s) {
        query = query.or(`name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async get(orgId: string, id: string) {
    const { data: lead } = await this.supabase.admin
      .from('leads')
      .select(LEAD_COLUMNS)
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!lead) throw new NotFoundException('Lead no encontrado');

    let conversation: unknown = null;
    if (lead.conversation_id) {
      const { data: conv } = await this.supabase.admin
        .from('conversations')
        .select('id, provider, contact_name, contact_handle, stage, mode, ai_enabled, last_message_at')
        .eq('id', lead.conversation_id)
        .eq('organization_id', orgId)
        .maybeSingle();
      conversation = conv ?? null;
    }
    return { lead, conversation };
  }

  async update(orgId: string, id: string, patch: LeadPatch) {
    const update: Record<string, unknown> = {};
    if (patch.status) update.status = patch.status;
    if (typeof patch.notes === 'string') update.notes = patch.notes;
    if (typeof patch.name === 'string') update.name = patch.name;
    if (typeof patch.email === 'string') update.email = normalizeEmail(patch.email);

    const { data, error } = await this.supabase.admin
      .from('leads')
      .update(update)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select(LEAD_COLUMNS)
      .single();
    if (error) throw error;

    // Si cambiamos el estado y hay conversación, la mantenemos alineada.
    if (patch.status && data?.conversation_id) {
      await this.supabase.admin
        .from('conversations')
        .update({ stage: patch.status })
        .eq('id', data.conversation_id)
        .eq('organization_id', orgId);
    }
    return data;
  }

  /** Métricas rápidas para las tarjetas del CRM. */
  async stats(orgId: string) {
    const { data } = await this.supabase.admin
      .from('leads')
      .select('status, source')
      .eq('organization_id', orgId)
      .limit(5000);
    const rows = data ?? [];
    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const r of rows) {
      const st = (r.status as string) || 'new';
      const sc = (r.source as string) || 'otro';
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      bySource[sc] = (bySource[sc] ?? 0) + 1;
    }
    return { total: rows.length, byStatus, bySource };
  }

  // ---------------------------------------------------------------------------

  private async findExisting(
    orgId: string,
    externalId: string | null,
    phone: string | null,
    email: string | null,
  ) {
    const pick = async (col: string, val: string) => {
      const { data } = await this.supabase.admin
        .from('leads')
        .select(LEAD_COLUMNS)
        .eq('organization_id', orgId)
        .eq(col, val)
        .maybeSingle();
      return data;
    };
    if (externalId) {
      const found = await pick('external_id', externalId);
      if (found) return found;
    }
    if (phone) {
      const found = await pick('phone', phone);
      if (found) return found;
    }
    if (email) {
      const found = await pick('email', email);
      if (found) return found;
    }
    return null;
  }
}

function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  return digits.length >= 7 ? `+${digits}` : null;
}

function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return e.includes('@') ? e : null;
}
