import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { safeWebhookUrlOrNull } from '../common/url-safety';

/** Datos para el webhook de salida "lead registrado" hacia GHL (paso 2). */
export type PushLeadInput = {
  orgId: string;
  conversationId: string;
  contactId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  source?: string | null;
};

type MatchKeys = {
  setterId?: string;
  contactId?: string;
  phone?: string;
  email?: string;
};

/**
 * Sincronización con GoHighLevel (GHL).
 *
 *   - SALIDA (paso 2): tras registrar el lead, hacemos POST al "Inbound Webhook"
 *     que el cliente configura en GHL, enviando el `setter_id` (UUID de la
 *     conversación) para que GHL lo guarde en un campo del contacto. Así ambos
 *     sistemas quedan enlazados.
 *   - ENTRADA (paso 4): cuando el lead agenda (o cancela) en GHL, GHL nos avisa;
 *     registramos la cita y pausamos/reanudamos los seguimientos.
 */
@Injectable()
export class GhlService {
  private readonly logger = new Logger(GhlService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Resuelve la organización a partir del intake_token (endpoints públicos). */
  async resolveOrgByToken(token: string): Promise<string> {
    if (!token) throw new ForbiddenException('Falta el token de integración');
    const { data } = await this.supabase.admin
      .from('integrations')
      .select('organization_id')
      .eq('intake_token', token)
      .maybeSingle();
    if (!data) throw new ForbiddenException('Token de integración inválido');
    return data.organization_id as string;
  }

  // --- SALIDA: paso 2 ---------------------------------------------------------

  /**
   * Envía a GHL el webhook "lead registrado" con el setter_id. Idempotente:
   * solo se envía una vez por conversación (si el anterior falló, se reintenta).
   * Best-effort: nunca lanza (se llama en fire-and-forget desde el intake).
   */
  async pushLeadRegistered(input: PushLeadInput): Promise<void> {
    try {
      const { data: integ } = await this.supabase.admin
        .from('integrations')
        .select('ghl_webhook_url')
        .eq('organization_id', input.orgId)
        .maybeSingle();
      // Revalidamos anti-SSRF antes de hacer la petición (defensa en profundidad:
      // el valor pudo guardarse antes de añadir la validación o corromperse).
      const url = safeWebhookUrlOrNull((integ?.ghl_webhook_url as string | null)?.trim());
      if (!url) return; // sin salida configurada o URL no permitida

      const { data: existing } = await this.supabase.admin
        .from('outbound_events')
        .select('id, status')
        .eq('conversation_id', input.conversationId)
        .eq('kind', 'ghl_lead_registered')
        .maybeSingle();
      if (existing?.status === 'sent') return; // ya enlazado, no reenviar

      const payload = {
        event: 'lead_registered',
        setter_id: input.conversationId,
        ghl_contact_id: input.contactId ?? null,
        name: input.name ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        source: input.source ?? null,
        status: 'new',
        sent_at: new Date().toISOString(),
      };

      let status = 'sent';
      const response: Record<string, unknown> = {};
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          // No seguir redirecciones: evita saltarse la validación anti-SSRF con
          // un 30x que apunte a un host interno.
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        response.http_status = res.status;
        if (!res.ok) {
          status = 'failed';
          response.body = (await res.text().catch(() => '')).slice(0, 500);
        }
      } catch (err) {
        status = 'failed';
        response.error = String(err);
      }

      const row = {
        organization_id: input.orgId,
        conversation_id: input.conversationId,
        kind: 'ghl_lead_registered',
        target_url: url,
        status,
        request: payload,
        response,
      };
      if (existing) {
        await this.supabase.admin.from('outbound_events').update(row).eq('id', existing.id);
      } else {
        await this.supabase.admin.from('outbound_events').insert(row);
      }

      if (status === 'failed') {
        this.logger.warn(
          `Webhook de salida a GHL falló (conv ${input.conversationId}): ${JSON.stringify(response)}`,
        );
      } else {
        this.logger.log(`Enlazado con GHL: setter_id enviado (conv ${input.conversationId})`);
      }
    } catch (err) {
      this.logger.warn(`pushLeadRegistered error: ${String(err)}`);
    }
  }

  // --- ENTRADA: paso 4 --------------------------------------------------------

  /**
   * Procesa el webhook de GHL cuando el lead agenda/reprograma/cancela una cita.
   * Correlaciona con la conversación por `setter_id` → `ghl_contact_id` →
   * teléfono/email, registra la cita y pausa (o reanuda) los seguimientos.
   */
  async handleAppointmentWebhook(
    orgId: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; matched: boolean; action: string }> {
    const appt = (body.appointment ?? body.calendar ?? {}) as Record<string, unknown>;
    const contact = (body.contact ?? {}) as Record<string, unknown>;
    const customData = (body.customData ?? {}) as Record<string, unknown>;

    const rawAction = str(
      body.action ?? body.event ?? body.type ?? body.status ?? appt.status ?? body.appointmentStatus,
    );
    const action = normalizeAction(rawAction);

    const keys: MatchKeys = {
      setterId: str(body.setter_id ?? body.setterId ?? customData.setter_id ?? appt.setter_id),
      contactId: str(body.contact_id ?? body.contactId ?? contact.id ?? appt.contact_id),
      phone: digits(str(body.phone ?? contact.phone ?? appt.phone)),
      email: (str(body.email ?? contact.email ?? appt.email) || '').toLowerCase() || undefined,
    };
    const startAt = parseIso(
      body.start_time ?? body.startTime ?? body.start ?? appt.start_time ?? appt.startTime,
    );
    const endAt = parseIso(
      body.end_time ?? body.endTime ?? body.end ?? appt.end_time ?? appt.endTime,
    );
    const eventId = str(
      body.appointment_id ?? body.appointmentId ?? appt.id ?? body.id ?? body.event_id,
    );
    const meetUrl =
      str(body.meeting_url ?? appt.meeting_url ?? appt.address ?? appt.location) || null;

    const conv = await this.findConversation(orgId, keys);

    if (action === 'cancelled') {
      await this.recordCancellation(orgId, eventId, conv?.id ?? null);
      if (conv) {
        await this.supabase.admin
          .from('conversations')
          .update({ followups_paused: false, stage: conv.stage === 'won' ? 'won' : 'qualified' })
          .eq('id', conv.id)
          .eq('organization_id', orgId);
        await this.syncLeadStatus(orgId, conv.id, 'qualified');
      }
      this.logger.log(`Cita CANCELADA en GHL (org ${orgId}, conv ${conv?.id ?? 'n/d'})`);
      return { ok: true, matched: Boolean(conv), action };
    }

    // Agendado / reprogramado / confirmado → registrar cita y PAUSAR seguimientos.
    await this.upsertAppointment(orgId, {
      conversationId: conv?.id ?? null,
      eventId,
      startAt,
      endAt,
      meetUrl,
    });

    if (conv) {
      await this.supabase.admin
        .from('conversations')
        .update({ stage: conv.stage === 'won' ? 'won' : 'call_scheduled', followups_paused: true })
        .eq('id', conv.id)
        .eq('organization_id', orgId);
      await this.syncLeadStatus(orgId, conv.id, 'call_scheduled');
      this.logger.log(`Cita AGENDADA en GHL → seguimientos pausados (conv ${conv.id})`);
    } else {
      this.logger.warn(
        `Cita de GHL sin conversación correlacionada (org ${orgId}, keys=${JSON.stringify(keys)})`,
      );
    }

    return { ok: true, matched: Boolean(conv), action };
  }

  // --- helpers ----------------------------------------------------------------

  /** Busca la conversación por setter_id → ghl_contact_id → teléfono → lead. */
  private async findConversation(
    orgId: string,
    keys: MatchKeys,
  ): Promise<{ id: string; stage: string } | null> {
    const sel = 'id, stage';

    if (keys.setterId && isUuid(keys.setterId)) {
      const { data } = await this.supabase.admin
        .from('conversations')
        .select(sel)
        .eq('organization_id', orgId)
        .eq('id', keys.setterId)
        .maybeSingle();
      if (data) return data as { id: string; stage: string };
    }

    if (keys.contactId) {
      const { data } = await this.supabase.admin
        .from('conversations')
        .select(sel)
        .eq('organization_id', orgId)
        .eq('ghl_contact_id', keys.contactId)
        .maybeSingle();
      if (data) return data as { id: string; stage: string };
    }

    if (keys.phone) {
      const { data } = await this.supabase.admin
        .from('conversations')
        .select(sel)
        .eq('organization_id', orgId)
        .eq('contact_handle', `+${keys.phone}`)
        .maybeSingle();
      if (data) return data as { id: string; stage: string };
    }

    // Último recurso: por el lead del CRM (external_id/teléfono/email) → conv.
    const leadConvId = await this.findConversationViaLead(orgId, keys);
    if (leadConvId) {
      const { data } = await this.supabase.admin
        .from('conversations')
        .select(sel)
        .eq('organization_id', orgId)
        .eq('id', leadConvId)
        .maybeSingle();
      if (data) return data as { id: string; stage: string };
    }

    return null;
  }

  private async findConversationViaLead(
    orgId: string,
    keys: MatchKeys,
  ): Promise<string | null> {
    const pick = async (col: string, val: string) => {
      const { data } = await this.supabase.admin
        .from('leads')
        .select('conversation_id')
        .eq('organization_id', orgId)
        .eq(col, val)
        .not('conversation_id', 'is', null)
        .maybeSingle();
      return (data?.conversation_id as string | null) ?? null;
    };
    if (keys.contactId) {
      const c = await pick('external_id', keys.contactId);
      if (c) return c;
    }
    if (keys.phone) {
      const c = await pick('phone', `+${keys.phone}`);
      if (c) return c;
    }
    if (keys.email) {
      const c = await pick('email', keys.email);
      if (c) return c;
    }
    return null;
  }

  private async upsertAppointment(
    orgId: string,
    a: {
      conversationId: string | null;
      eventId?: string;
      startAt: string | null;
      endAt: string | null;
      meetUrl: string | null;
    },
  ): Promise<void> {
    const base = {
      organization_id: orgId,
      conversation_id: a.conversationId,
      start_at: a.startAt,
      end_at: a.endAt,
      meet_url: a.meetUrl,
      status: 'scheduled',
      detected_by: 'ghl',
      external_event_id: a.eventId ?? null,
      notes: 'Agendada en GoHighLevel',
    };

    if (a.eventId) {
      const { data: existing } = await this.supabase.admin
        .from('appointments')
        .select('id')
        .eq('organization_id', orgId)
        .eq('external_event_id', a.eventId)
        .maybeSingle();
      if (existing) {
        await this.supabase.admin.from('appointments').update(base).eq('id', existing.id);
        return;
      }
    } else if (a.conversationId) {
      const { data: existing } = await this.supabase.admin
        .from('appointments')
        .select('id')
        .eq('organization_id', orgId)
        .eq('conversation_id', a.conversationId)
        .eq('status', 'scheduled')
        .maybeSingle();
      if (existing) {
        await this.supabase.admin
          .from('appointments')
          .update({ start_at: a.startAt, end_at: a.endAt, meet_url: a.meetUrl })
          .eq('id', existing.id);
        return;
      }
    }
    await this.supabase.admin.from('appointments').insert(base);
  }

  private async recordCancellation(
    orgId: string,
    eventId: string | undefined,
    conversationId: string | null,
  ): Promise<void> {
    if (eventId) {
      await this.supabase.admin
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('organization_id', orgId)
        .eq('external_event_id', eventId);
      return;
    }
    if (conversationId) {
      await this.supabase.admin
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('organization_id', orgId)
        .eq('conversation_id', conversationId)
        .eq('status', 'scheduled');
    }
  }

  private async syncLeadStatus(orgId: string, conversationId: string, status: string): Promise<void> {
    await this.supabase.admin
      .from('leads')
      .update({ status })
      .eq('organization_id', orgId)
      .eq('conversation_id', conversationId);
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function digits(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = v.replace(/[^\d]/g, '');
  return d.length >= 7 ? d : undefined;
}

function parseIso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Normaliza el tipo de acción del webhook a: cancelled | booked. */
function normalizeAction(raw: string | undefined): 'cancelled' | 'booked' {
  const a = (raw ?? '').toLowerCase();
  if (/cancel|delete|remove|no.?show|noshow/.test(a)) return 'cancelled';
  return 'booked'; // booked | scheduled | confirmed | rescheduled | (por defecto)
}
