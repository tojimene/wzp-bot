import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SetterConfigService } from '../setter/setter-config.service';
import { MessagingService } from '../messaging/messaging.service';
import { GhlService } from '../ghl/ghl.service';
import { WorkflowEngineService } from '../workflows/workflow-engine.service';
import { LeadsService } from './leads.service';

export type IntakeInput = {
  /** Token de la org (intake_token de la tabla integrations). */
  token: string;
  name?: string;
  phone?: string;
  email?: string;
  /** Canal por el que contactar (por defecto whatsapp). */
  channel?: 'whatsapp' | 'instagram' | 'messenger';
  /** De dónde viene el lead. */
  source?: string;
  source_detail?: string;
  campaign?: string;
  /** Primer mensaje del lead, si lo hay (p.ej. comentario de IG). */
  message?: string;
  /** Id del contacto en el sistema externo (ManyChat subscriber, etc.). */
  external_id?: string;
  /** Id del contacto en GoHighLevel (para devolverle webhooks de salida). */
  ghl_contact_id?: string;
  /** Si false, no se envía el primer mensaje proactivo (solo se registra). */
  proactive?: boolean;
  /** Payload original completo (para guardarlo íntegro en el CRM). */
  raw?: Record<string, unknown>;
};

export type IntakeResult = {
  conversationId: string | null;
  leadId: string | null;
  proactiveSent: boolean;
  reason?: string;
};

@Injectable()
export class LeadIntakeService {
  private readonly logger = new Logger(LeadIntakeService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly setterConfig: SetterConfigService,
    private readonly messaging: MessagingService,
    private readonly leads: LeadsService,
    private readonly ghl: GhlService,
    private readonly workflow: WorkflowEngineService,
  ) {}

  /** Resuelve la organización a partir del token de intake. */
  private async resolveOrg(token: string) {
    if (!token) throw new ForbiddenException('Falta el token de integración');
    const { data } = await this.supabase.admin
      .from('integrations')
      .select('organization_id, default_channel_id, proactive_enabled')
      .eq('intake_token', token)
      .maybeSingle();
    if (!data) throw new ForbiddenException('Token de integración inválido');
    return data as {
      organization_id: string;
      default_channel_id: string | null;
      proactive_enabled: boolean;
    };
  }

  /** Elige el canal a usar: el por defecto de la org, o el primero del proveedor. */
  private async pickChannel(orgId: string, defaultChannelId: string | null, provider: string) {
    if (defaultChannelId) {
      const { data } = await this.supabase.admin
        .from('channels')
        .select('id, provider, unipile_account_id, status')
        .eq('id', defaultChannelId)
        .eq('organization_id', orgId)
        .maybeSingle();
      if (data) return data;
    }
    const { data } = await this.supabase.admin
      .from('channels')
      .select('id, provider, unipile_account_id, status')
      .eq('organization_id', orgId)
      .eq('provider', provider)
      .limit(1)
      .maybeSingle();
    return data;
  }

  async intake(input: IntakeInput): Promise<IntakeResult> {
    const org = await this.resolveOrg(input.token);
    const orgId = org.organization_id;
    const provider = input.channel ?? 'whatsapp';
    const phoneDigits = normalizePhone(input.phone);

    // El lead entra SIEMPRE al CRM lo PRIMERO, con toda su información (incluido
    // el payload original completo), aunque todavía no haya canal para escribirle
    // o falte el teléfono. El CRM es la fuente de verdad de "quién ha entrado".
    let leadId: string | null = null;
    try {
      const lead = await this.leads.record(orgId, {
        name: input.name,
        phone: phoneDigits ? `+${phoneDigits}` : input.phone,
        email: input.email,
        provider,
        source: input.source,
        sourceDetail: input.source_detail,
        campaign: input.campaign,
        externalId: input.external_id,
        firstMessage: input.message,
        consentOptin: true,
        raw: input.raw ?? {},
      });
      leadId = (lead?.id as string | undefined) ?? null;
    } catch (err) {
      this.logger.warn(`No se pudo registrar el lead en el CRM: ${String(err)}`);
    }

    // Sin datos de contacto no podemos abrir conversación, pero el lead ya quedó
    // registrado en el CRM para que el usuario lo vea y lo trabaje a mano.
    if (provider === 'whatsapp' && !phoneDigits && !input.external_id) {
      await this.warnIfGhlOutboundSkipped(orgId, 'el lead no trae teléfono');
      return { conversationId: null, leadId, proactiveSent: false, reason: 'lead sin teléfono' };
    }

    // El canal (WhatsApp) puede NO estar conectado todavía: la conexión suele ser
    // el ÚLTIMO paso del onboarding. Aun así abrimos la conversación (channel_id
    // admite null) para tener un `setter_id` estable y enlazar con GHL desde ya.
    // El envío real de mensajes se activará cuando exista canal.
    const channel = await this.pickChannel(orgId, org.default_channel_id, provider);

    // Buscamos conversación existente por teléfono/subscriber para no duplicar.
    const conv = await this.findOrCreateConversation(orgId, channel, provider, phoneDigits, input);

    // Enlazamos el lead del CRM con la conversación que abrirá el bot.
    if (leadId) {
      try {
        await this.leads.linkConversation(orgId, leadId, conv.id);
      } catch (err) {
        this.logger.warn(`No se pudo enlazar el lead con su conversación: ${String(err)}`);
      }
    }

    // Paso 2: devolvemos a GHL el setter_id (UUID de la conversación) para que lo
    // guarde en un campo del contacto y ambos sistemas queden enlazados. Es
    // best-effort y no bloquea el intake (no-op si la org no tiene GHL de salida).
    void this.ghl.pushLeadRegistered({
      orgId,
      conversationId: conv.id,
      contactId: input.ghl_contact_id ?? input.external_id ?? null,
      name: input.name ?? null,
      phone: phoneDigits ? `+${phoneDigits}` : input.phone ?? null,
      email: input.email ?? null,
      source: input.source ?? null,
    });

    // Guardamos en la conversación el contexto que dejó el lead (respuestas del
    // formulario, incluida la de cualificación) para que el bot lo tenga en cuenta.
    const leadContext = buildLeadContext(input);
    if (leadContext) {
      try {
        await this.supabase.admin
          .from('conversations')
          .update({ lead_context: leadContext })
          .eq('id', conv.id);
      } catch (err) {
        this.logger.warn(`No se pudo guardar el contexto del lead: ${String(err)}`);
      }
    }

    // A partir de aquí necesitamos un canal conectado para escribir al lead. Si no
    // lo hay, ya cumplimos lo importante (lead en CRM + setter_id enviado a GHL);
    // el primer mensaje saldrá cuando se conecte WhatsApp.
    if (!channel) {
      return {
        conversationId: conv.id,
        leadId,
        proactiveSent: false,
        reason: `sin canal de ${provider} conectado (lead y enlace GHL OK; falta conectar canal para escribir)`,
      };
    }

    const wantsProactive = (input.proactive ?? true) && org.proactive_enabled;
    if (!wantsProactive) {
      return { conversationId: conv.id, leadId, proactiveSent: false, reason: 'proactivo desactivado' };
    }
    if (conv.proactive_sent) {
      return { conversationId: conv.id, leadId, proactiveSent: false, reason: 'ya se contactó antes' };
    }

    // Por ahora el primer mensaje proactivo solo está soportado en WhatsApp
    // (en IG/Messenger la ventana de 24h obliga a pasar por ManyChat).
    if (provider !== 'whatsapp') {
      return {
        conversationId: conv.id,
        leadId,
        proactiveSent: false,
        reason: 'proactivo solo en WhatsApp',
      };
    }

    // Si hay un workflow "Lead entra" ACTIVO, es la fuente de verdad del primer
    // mensaje + seguimientos. Sustituye a la plantilla proactiva simple.
    const startedWorkflow = await this.workflow.startForConversation(orgId, conv.id, 'lead_created');
    if (startedWorkflow) {
      return {
        conversationId: conv.id,
        leadId,
        proactiveSent: true,
        reason: 'workflow "Lead entra" iniciado',
      };
    }

    const cfg = await this.setterConfig.getOrCreate(orgId);
    const template = (cfg.proactive_template ?? '').trim();
    if (!template) {
      return {
        conversationId: conv.id,
        leadId,
        proactiveSent: false,
        reason: 'no hay plantilla proactiva configurada',
      };
    }
    if (!cfg.is_active) {
      return {
        conversationId: conv.id,
        leadId,
        proactiveSent: false,
        reason: 'IA desactivada globalmente',
      };
    }

    const text = renderTemplate(template, { name: input.name ?? '' });

    // El envío real lo hace la cola con throttling (espaciado + horario activo),
    // para proteger el número de WhatsApp.
    const { delayMs } = await this.messaging.enqueueProactive({
      orgId,
      conversationId: conv.id,
      accountId: channel.unipile_account_id as string,
      attendeeId: phoneDigits as string,
      content: text,
    });

    this.logger.log(
      `Lead encolado para contacto proactivo (conv ${conv.id}, source=${input.source ?? 'n/d'}, en ~${Math.round(delayMs / 1000)}s)`,
    );
    return {
      conversationId: conv.id,
      leadId,
      proactiveSent: true,
      reason: delayMs > 1000 ? `programado en ~${Math.round(delayMs / 1000)}s` : undefined,
    };
  }

  /**
   * Si la org tiene configurado el webhook de salida a GHL pero el intake se
   * corta antes de poder enviarlo (sin canal / sin teléfono), lo dejamos claro
   * en los logs. Así es fácil diagnosticar "GHL no recibe el setter_id".
   */
  private async warnIfGhlOutboundSkipped(orgId: string, why: string): Promise<void> {
    try {
      const { data } = await this.supabase.admin
        .from('integrations')
        .select('ghl_webhook_url')
        .eq('organization_id', orgId)
        .maybeSingle();
      if (data?.ghl_webhook_url) {
        this.logger.warn(
          `[GHL salida OMITIDA] org ${orgId}: ${why}. El lead se registró en el CRM, ` +
            `pero NO se envió el webhook "lead_registered" con el setter_id a GHL.`,
        );
      }
    } catch {
      /* best-effort: nunca rompe el intake */
    }
  }

  /** Si la conversación existía sin canal y ahora hay uno, la vincula. */
  private async attachChannelIfMissing(
    conv: { id: string; channel_id?: string | null },
    channel: { id: string } | null,
  ): Promise<void> {
    if (channel && !conv.channel_id) {
      await this.supabase.admin
        .from('conversations')
        .update({ channel_id: channel.id })
        .eq('id', conv.id);
    }
  }

  private async findOrCreateConversation(
    orgId: string,
    channel: { id: string; provider: string } | null,
    provider: string,
    phoneDigits: string | null,
    input: IntakeInput,
  ): Promise<{
    id: string;
    proactive_sent: boolean;
    unipile_chat_id: string | null;
    contact_external_id: string | null;
  }> {
    const handle = phoneDigits ? `+${phoneDigits}` : null;

    // 1) Por subscriber externo (ManyChat, etc.)
    if (input.external_id) {
      const { data } = await this.supabase.admin
        .from('conversations')
        .select('id, proactive_sent, unipile_chat_id, contact_external_id, channel_id')
        .eq('organization_id', orgId)
        .eq('external_subscriber_id', input.external_id)
        .eq('is_test', false)
        .maybeSingle();
      if (data) {
        await this.attachChannelIfMissing(data, channel);
        return data;
      }
    }

    // 2) Por teléfono (handle) dentro de la org y proveedor. No restringimos por
    // channel_id para reencontrar conversaciones creadas ANTES de conectar el
    // canal (channel_id = null) y así re-vincularlas cuando el canal aparece.
    if (handle) {
      const { data } = await this.supabase.admin
        .from('conversations')
        .select('id, proactive_sent, unipile_chat_id, contact_external_id, channel_id')
        .eq('organization_id', orgId)
        .eq('provider', provider)
        .eq('contact_handle', handle)
        .eq('is_test', false)
        .maybeSingle();
      if (data) {
        // Actualizamos origen/consentimiento por si llega más info y, si la
        // conversación no tenía canal, la vinculamos al que ahora sí existe.
        await this.supabase.admin
          .from('conversations')
          .update({
            source: input.source ?? null,
            source_detail: input.source_detail ?? null,
            campaign: input.campaign ?? null,
            ...(input.ghl_contact_id ? { ghl_contact_id: input.ghl_contact_id } : {}),
            ...(channel && !data.channel_id ? { channel_id: channel.id } : {}),
            consent_optin: true,
            mode: 'setter',
            ai_enabled: true,
          })
          .eq('id', data.id);
        return data;
      }
    }

    const { data: created, error } = await this.supabase.admin
      .from('conversations')
      .insert({
        organization_id: orgId,
        channel_id: channel?.id ?? null,
        provider,
        contact_name: input.name ?? 'Lead',
        contact_handle: handle,
        external_subscriber_id: input.external_id ?? null,
        ghl_contact_id: input.ghl_contact_id ?? null,
        source: input.source ?? null,
        source_detail: input.source_detail ?? null,
        campaign: input.campaign ?? null,
        consent_optin: true,
        // Origen de campaña/lead → siempre setter, y fijado (no reclasificar).
        mode: 'setter',
        mode_locked: true,
        ai_enabled: true,
        is_test: false,
        stage: 'new',
      })
      .select('id, proactive_sent, unipile_chat_id, contact_external_id')
      .single();
    if (error) throw error;
    return created;
  }
}

/**
 * Construye un texto legible con lo que dejó el lead: email, primer mensaje y,
 * sobre todo, las respuestas del formulario (incluida la de cualificación, que
 * en GHL viene como un campo personalizado con nombre arbitrario). Recorre el
 * payload original e incluye todo lo que no sea un campo de control conocido.
 */
function buildLeadContext(input: IntakeInput): string | null {
  const lines: string[] = [];
  if (input.email) lines.push(`Email: ${input.email}`);
  if (input.source_detail) lines.push(`Origen: ${input.source_detail}`);
  if (input.campaign) lines.push(`Campaña: ${input.campaign}`);
  if (input.message) lines.push(`Primer mensaje / comentario: ${input.message}`);

  // Campos de control/estructura que NO son respuestas del formulario (y que, si
  // se volcaran, ensuciarían el contexto del bot con JSON gigante o metadatos).
  const CONTROL = new Set([
    'token',
    'name',
    'full_name',
    'fullname',
    'first_name',
    'firstname',
    'last_name',
    'lastname',
    'phone',
    'phone_number',
    'phonenumber',
    'email',
    'channel',
    'source',
    'source_detail',
    'form_name',
    'page_name',
    'campaign',
    'utm_campaign',
    'ad_id',
    'message',
    'external_id',
    'subscriber_id',
    'proactive',
    'raw',
    // Estructura/metadatos típicos de GoHighLevel:
    'customdata',
    'contact',
    'location',
    'workflow',
    'triggerdata',
    'contact_id',
    'contact_type',
    'date_created',
    'tags',
  ]);

  const raw = input.raw ?? {};
  for (const [key, value] of Object.entries(raw)) {
    if (CONTROL.has(key.toLowerCase())) continue;
    if (value === null || value === undefined || value === '') continue;
    const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
    lines.push(`${humanizeKey(key)}: ${val}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/** "utm_source" → "Utm source"; "qualification_answer" → "Qualification answer". */
function humanizeKey(key: string): string {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Deja solo dígitos (formato internacional sin +). */
function normalizePhone(phone?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  return digits.length >= 7 ? digits : null;
}

/** Sustituye variables tipo {nombre}/{name} en la plantilla. */
function renderTemplate(tpl: string, vars: { name: string }): string {
  const first = (vars.name || '').trim().split(/\s+/)[0] ?? '';
  return tpl
    .replace(/\{\s*(nombre|name|first_name)\s*\}/gi, first)
    .replace(/\{\s*(nombre_completo|full_name)\s*\}/gi, vars.name.trim())
    .trim();
}
