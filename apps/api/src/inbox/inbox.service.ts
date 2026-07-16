import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  UnipileService,
  type UnipileAttendee,
  type UnipileChat,
  type UnipileMessage,
} from '../unipile/unipile.service';
import { MessagingService } from '../messaging/messaging.service';
import { ConversionsApiService } from '../whatsapp-cloud/conversions-api.service';

type FunnelStage =
  | 'new'
  | 'qualifying'
  | 'qualified'
  | 'not_qualified'
  | 'call_scheduled'
  | 'won'
  | 'lost';

const MAX_CHATS = 40;
const MAX_MESSAGES = 25;

@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly unipile: UnipileService,
    private readonly messaging: MessagingService,
    private readonly capi: ConversionsApiService,
  ) {}

  async list(orgId: string, stage?: string, archived = false) {
    let query = this.supabase.admin
      .from('conversations')
      .select(
        'id, provider, contact_name, contact_handle, stage, mode, ai_enabled, blocked, unread_count, last_message_at, created_at',
      )
      .eq('organization_id', orgId)
      .eq('is_test', false)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    // Por defecto ocultamos las conversaciones archivadas (canales desconectados).
    query = archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);

    if (stage) query = query.eq('stage', stage);

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async get(orgId: string, id: string) {
    const conv = await this.assertOwned(orgId, id);

    // Trae el historial reciente desde Unipile (rellena lo que no vino por webhook).
    if (conv.unipile_chat_id) {
      try {
        await this.importMessages(orgId, id, conv.unipile_chat_id as string, MAX_MESSAGES);
      } catch (err) {
        this.logger.warn(`No se pudo refrescar historial: ${String(err)}`);
      }

      // Resolvemos por los participantes del chat lo que falte:
      //  - el nombre, si sigue como 'Lead' o vacío
      //  - el teléfono real, si el handle es un id interno (@lid / @...) o falta
      const needName = !conv.contact_name || conv.contact_name === 'Lead';
      const needPhone = !conv.contact_handle || conv.contact_handle.includes('@');
      if (needName || needPhone) {
        const { name, handle } = await this.resolveAttendee(conv.unipile_chat_id as string);
        const update: Record<string, unknown> = {};
        if (needName && name) {
          conv.contact_name = name;
          update.contact_name = name;
        }
        if (needPhone && handle) {
          conv.contact_handle = handle;
          update.contact_handle = handle;
        }
        if (Object.keys(update).length > 0) {
          await this.supabase.admin.from('conversations').update(update).eq('id', id);
        }
      }
    }

    const { data: messages } = await this.supabase.admin
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });

    if ((conv.unread_count ?? 0) > 0) {
      await this.supabase.admin
        .from('conversations')
        .update({ unread_count: 0 })
        .eq('id', id);
    }

    return { conversation: { ...conv, unread_count: 0 }, messages: messages ?? [] };
  }

  async update(
    orgId: string,
    id: string,
    patch: {
      ai_enabled?: boolean;
      stage?: FunnelStage;
      mode?: 'setter' | 'support' | 'ignored';
      notes?: string;
      blocked?: boolean;
      unread?: boolean;
      assigned_to?: string | null;
    },
  ) {
    await this.assertOwned(orgId, id);
    const update: Record<string, unknown> = {};
    if (typeof patch.ai_enabled === 'boolean') update.ai_enabled = patch.ai_enabled;
    if (patch.stage) update.stage = patch.stage;
    if (patch.mode) {
      // Si el usuario fija el modo a mano, lo bloqueamos (no reclasificar).
      update.mode = patch.mode;
      update.mode_locked = true;
    }
    if (typeof patch.notes === 'string') update.notes = patch.notes;
    if (typeof patch.unread === 'boolean') update.unread_count = patch.unread ? 1 : 0;
    // Asignar (o desasignar con cadena vacía / null) el chat a un miembro.
    if (patch.assigned_to !== undefined) {
      update.assigned_to = patch.assigned_to ? patch.assigned_to : null;
    }
    if (typeof patch.blocked === 'boolean') {
      update.blocked = patch.blocked;
      // Al bloquear, la IA deja de responder a este contacto.
      if (patch.blocked) update.ai_enabled = false;
    }

    const { data, error } = await this.supabase.admin
      .from('conversations')
      .update(update)
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('id, stage, mode, ai_enabled, blocked, notes, unread_count, assigned_to')
      .single();
    if (error) throw error;

    // Mantenemos el CRM sincronizado: si cambia la etapa, actualizamos el lead.
    if (patch.stage) {
      await this.supabase.admin
        .from('leads')
        .update({ status: patch.stage })
        .eq('organization_id', orgId)
        .eq('conversation_id', id);
    }

    // Atribución a Meta: al CUALIFICAR (o GANAR) un lead que vino de un anuncio
    // click-to-WhatsApp, devolvemos el evento a la Conversions API.
    if (patch.stage === 'qualified' || patch.stage === 'won') {
      void this.maybeReportConversion(orgId, id, patch.stage);
    }
    return data;
  }

  /** Envía el evento de conversión a Meta si la conversación trae `ctwa_clid`. */
  private async maybeReportConversion(orgId: string, id: string, stage: FunnelStage) {
    try {
      const { data: conv } = await this.supabase.admin
        .from('conversations')
        .select('referral, contact_handle')
        .eq('id', id)
        .eq('organization_id', orgId)
        .maybeSingle();
      const ctwaClid = (conv?.referral as { ctwa_clid?: string } | null)?.ctwa_clid;
      if (!ctwaClid) return;
      await this.capi.sendConversion({
        orgId,
        conversationId: id,
        ctwaClid,
        eventName: stage === 'won' ? 'Purchase' : 'Lead',
        phone: conv?.contact_handle as string | null,
      });
    } catch (err) {
      this.logger.warn(`No se pudo reportar conversión a Meta: ${String(err)}`);
    }
  }

  async remove(orgId: string, id: string) {
    await this.assertOwned(orgId, id);
    const { error } = await this.supabase.admin
      .from('conversations')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId);
    if (error) throw error;
    return { ok: true };
  }

  async sendAgentMessage(orgId: string, id: string, content: string) {
    await this.assertOwned(orgId, id);
    return this.messaging.sendAgentMessage(orgId, id, content);
  }

  /**
   * Nombre + teléfono real del contacto a partir de los participantes del chat.
   * El teléfono viene en `specifics.phone_number` o en `public_identifier`
   * (`<num>@s.whatsapp.net`); `provider_id` suele ser el id interno `@lid`.
   */
  private async resolveAttendee(chatId: string): Promise<{ name?: string; handle?: string }> {
    try {
      const attendees = await this.unipile.listChatAttendees(chatId);
      const other = attendees.find((a) => !(a.is_self === 1 || a.is_self === true));
      if (other) {
        return { name: other.name?.trim() || undefined, handle: phoneOf(other) };
      }
    } catch (err) {
      this.logger.warn(`No se pudieron leer los participantes del chat: ${String(err)}`);
    }
    return {};
  }

  /**
   * Sincroniza los chats de WhatsApp/IG/etc. desde Unipile. Los chats antiguos
   * se importan con la IA DESACTIVADA (no queremos que el bot escriba a contactos
   * antiguos de golpe); el usuario la activa por chat cuando quiera.
   */
  async sync(orgId: string) {
    const { data: channels } = await this.supabase.admin
      .from('channels')
      .select('id, provider, unipile_account_id')
      .eq('organization_id', orgId)
      .eq('status', 'connected')
      .not('unipile_account_id', 'is', null);

    let chatsSeen = 0;

    for (const channel of channels ?? []) {
      let chats: UnipileChat[] = [];
      try {
        chats = await this.unipile.listChats(channel.unipile_account_id as string, MAX_CHATS);
      } catch (err) {
        this.logger.error(`No se pudieron listar chats: ${String(err)}`);
        continue;
      }

      for (const chat of chats) {
        if (!chat.id) continue;
        chatsSeen += 1;
        // Solo creamos la conversación; el historial se carga al abrir el chat
        // (get → importMessages), igual que WhatsApp Web. Así el sync es rápido.
        await this.upsertSyncedConversation(orgId, channel, chat);
      }
    }

    return { channels: channels?.length ?? 0, chats: chatsSeen };
  }

  // ---------------------------------------------------------------------------

  private async importMessages(
    orgId: string,
    convId: string,
    chatId: string,
    limit: number,
  ): Promise<number> {
    const msgs = await this.unipile.listChatMessages(chatId, limit);
    if (!msgs.length) return 0;

    const { data: existing } = await this.supabase.admin
      .from('messages')
      .select('id, role, content, metadata')
      .eq('conversation_id', convId);

    // IDs de proveedor ya guardados: no se reimportan.
    const seen = new Set(
      (existing ?? [])
        .map((m) => (m.metadata as { message_id?: string } | null)?.message_id)
        .filter(Boolean) as string[],
    );

    // Mensajes que YA guardamos al enviar/recibir pero sin `message_id`
    // (los salientes del bot se persisten con metadata vacía). Los reconciliamos
    // con el eco de Unipile en lugar de duplicarlos. Clave: lado + contenido.
    const unreconciled = new Map<
      string,
      { id: string; meta: Record<string, unknown> }[]
    >();
    for (const m of existing ?? []) {
      const meta = (m.metadata as Record<string, unknown> | null) ?? {};
      if (meta.message_id) continue;
      const role = m.role as string;
      const side =
        role === 'contact' ? 'in' : role === 'assistant' || role === 'agent' ? 'out' : null;
      if (!side) continue;
      const key = `${side}::${String(m.content ?? '').trim()}`;
      const arr = unreconciled.get(key) ?? [];
      arr.push({ id: m.id as string, meta });
      unreconciled.set(key, arr);
    }

    const rows: Array<{
      conversation_id: string;
      organization_id: string;
      role: 'assistant' | 'contact';
      content: string;
      created_at: string;
      metadata: Record<string, unknown>;
    }> = [];
    const backfills: { id: string; metadata: Record<string, unknown> }[] = [];

    for (const m of msgs) {
      const id = m.id ? String(m.id) : '';
      const text = (m.text ?? '').trim();
      if (!id || !text || seen.has(id)) continue;

      const key = `${isFromUs(m) ? 'out' : 'in'}::${text}`;
      const pool = unreconciled.get(key);
      if (pool && pool.length > 0) {
        // Ya lo teníamos guardado sin id: rellenamos el message_id y NO duplicamos.
        const row = pool.shift()!;
        backfills.push({
          id: row.id,
          metadata: { ...row.meta, message_id: id, reconciled: true },
        });
        seen.add(id);
        continue;
      }

      rows.push({
        conversation_id: convId,
        organization_id: orgId,
        role: isFromUs(m) ? ('assistant' as const) : ('contact' as const),
        content: text,
        created_at: timestampOf(m),
        metadata: { message_id: id, imported: true },
      });
    }

    // Backfill de message_id en filas existentes (evita duplicados en futuros syncs).
    for (const b of backfills) {
      await this.supabase.admin
        .from('messages')
        .update({ metadata: b.metadata })
        .eq('id', b.id);
    }

    if (rows.length === 0) return 0;

    const { error } = await this.supabase.admin.from('messages').insert(rows);
    if (error) {
      this.logger.error(`Error importando mensajes: ${error.message}`);
      return 0;
    }

    // Actualiza last_message_at con el mensaje más reciente.
    const latest = rows.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    await this.supabase.admin
      .from('conversations')
      .update({ last_message_at: latest.created_at })
      .eq('id', convId);

    return rows.length;
  }

  private async upsertSyncedConversation(
    orgId: string,
    channel: { id: string; provider: string },
    chat: UnipileChat,
  ) {
    const { data: existing } = await this.supabase.admin
      .from('conversations')
      .select('id, contact_name')
      .eq('organization_id', orgId)
      .eq('channel_id', channel.id)
      .eq('contact_external_id', chat.id)
      .eq('is_test', false)
      .maybeSingle();

    // Nombre y teléfono reales: el chat trae `name` en grupos; en WhatsApp 1:1
    // tanto el nombre como el teléfono salen de los participantes.
    let name = chat.name?.trim();
    let handle: string | null = null;
    const resolved = await this.resolveAttendee(chat.id);
    if (!name && resolved.name) name = resolved.name;
    if (resolved.handle) handle = resolved.handle;

    if (existing) {
      const update: Record<string, unknown> = {};
      if ((!existing.contact_name || existing.contact_name === 'Lead') && name) {
        update.contact_name = name;
      }
      if (handle) update.contact_handle = handle;
      if (Object.keys(update).length > 0) {
        await this.supabase.admin
          .from('conversations')
          .update(update)
          .eq('id', existing.id);
      }
      return existing;
    }

    const { data: created, error } = await this.supabase.admin
      .from('conversations')
      .insert({
        organization_id: orgId,
        channel_id: channel.id,
        provider: channel.provider,
        contact_external_id: chat.id,
        unipile_chat_id: chat.id,
        contact_handle: handle,
        contact_name: name ?? 'Lead',
        is_test: false,
        ai_enabled: false, // chats antiguos: IA en pausa por defecto
        stage: 'new',
        last_message_at: timestampOrNull(chat.timestamp),
      })
      .select('id, contact_name')
      .single();
    if (error) throw error;
    return created;
  }

  private async assertOwned(orgId: string, id: string) {
    const { data } = await this.supabase.admin
      .from('conversations')
      .select(
        'id, provider, contact_name, contact_handle, stage, mode, mode_locked, ai_enabled, blocked, notes, unread_count, assigned_to, unipile_chat_id, ai_analysis, ai_analysis_at, last_message_at, created_at',
      )
      .eq('id', id)
      .eq('organization_id', orgId)
      .eq('is_test', false)
      .maybeSingle();
    if (!data) throw new NotFoundException('Conversación no encontrada');
    return data;
  }

  /** Miembros de la organización (para asignar chats). */
  async members(orgId: string) {
    const { data: mems } = await this.supabase.admin
      .from('memberships')
      .select('user_id, role')
      .eq('organization_id', orgId);
    const ids = (mems ?? []).map((m) => m.user_id as string);
    if (ids.length === 0) return [];
    const { data: profiles } = await this.supabase.admin
      .from('profiles')
      .select('id, email, full_name')
      .in('id', ids);
    const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));
    return (mems ?? []).map((m) => {
      const p = byId.get(m.user_id as string);
      return {
        user_id: m.user_id as string,
        role: m.role as string,
        email: (p?.email as string) ?? null,
        full_name: (p?.full_name as string) ?? null,
      };
    });
  }
}

/**
 * Teléfono real del participante. Preferimos `specifics.phone_number` (ya viene
 * con +). Si no, lo sacamos de `public_identifier` (`<num>@s.whatsapp.net`).
 * Nunca devolvemos el `provider_id` cuando es un id interno `@lid`.
 */
function phoneOf(att: UnipileAttendee): string | undefined {
  const phone = att.specifics?.phone_number?.trim();
  if (phone) return phone;

  const fromPublic = matchPhone(att.public_identifier);
  if (fromPublic) return fromPublic;

  const fromProvider = matchPhone(att.provider_id);
  if (fromProvider) return fromProvider;

  return undefined;
}

/** Extrae `+<digitos>` de algo como `34607196457@s.whatsapp.net`. */
function matchPhone(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{6,15})@s\.whatsapp\.net$/.exec(raw.trim());
  return m ? `+${m[1]}` : undefined;
}

function isFromUs(m: UnipileMessage): boolean {
  return m.is_sender === 1 || m.is_sender === true;
}

function timestampOf(m: UnipileMessage): string {
  const raw = m.timestamp ?? m.date;
  const d = raw ? new Date(raw) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function timestampOrNull(raw?: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
