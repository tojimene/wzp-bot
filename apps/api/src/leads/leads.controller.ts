import { Body, Controller, HttpCode, Logger, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LeadIntakeService, type IntakeInput } from './lead-intake.service';

/**
 * Endpoints PÚBLICOS de entrada de leads (sin JWT). La autenticidad se valida
 * con el `intake_token` de la organización (por query ?token=...).
 *
 *   - /api/leads/intake → formato genérico (Zapier, Make, tu propio form…).
 *   - /api/leads/ghl    → payload de un webhook de GoHighLevel (Meta Lead Ads).
 */
@Controller('leads')
// Endpoints públicos protegidos por token de org: límite estricto por IP para
// frenar el descubrimiento del token por fuerza bruta.
@Throttle({ default: { ttl: 60_000, limit: 60 } })
export class LeadsController {
  private readonly logger = new Logger(LeadsController.name);

  constructor(private readonly intake: LeadIntakeService) {}

  @Post('intake')
  @HttpCode(200)
  async generic(
    @Query('token') token: string,
    @Body() body: Record<string, unknown>,
  ) {
    // Endpoint genérico (Zapier, Make, formularios propios). Extraemos los campos
    // de forma tolerante: si el que integra manda `name`/`phone` los usamos, pero
    // también entendemos `first_name`/`full_name` y payloads anidados (GHL suele
    // apuntar aquí por error). Si el payload parece de GHL, marcamos la fuente.
    const f = extractLeadFields(body);
    const explicitSource = str(body.source);
    return this.intake.intake({
      token,
      name: f.name,
      phone: f.phone,
      email: f.email,
      channel: str(body.channel) as IntakeInput['channel'],
      source: explicitSource ?? (looksLikeGhl(body) ? 'ghl' : 'webhook'),
      source_detail:
        str(body.source_detail) ?? str(body.form_name) ?? str(body.page_name),
      campaign: str(body.campaign) ?? str(body.utm_campaign) ?? str(body.ad_id),
      message: f.message,
      external_id: str(body.external_id) ?? str(body.subscriber_id),
      proactive: typeof body.proactive === 'boolean' ? body.proactive : undefined,
      raw: body,
    });
  }

  @Post('ghl')
  @HttpCode(200)
  async ghl(
    @Query('token') token: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.intake.intake(mapGhl(body, token));
  }
}

/**
 * Extrae nombre/teléfono/email/mensaje de un payload de forma robusta. Busca en
 * la raíz y también en objetos anidados habituales (`customData`, `contact` de
 * GoHighLevel), y entiende variantes de nombre (`name`, `full_name`,
 * `first_name` + `last_name`, camelCase incluido).
 */
function extractLeadFields(body: Record<string, unknown>): {
  name?: string;
  phone?: string;
  email?: string;
  message?: string;
} {
  const nested = [
    body,
    body.customData as Record<string, unknown> | undefined,
    body.contact as Record<string, unknown> | undefined,
  ];
  const full = pick(nested, ['full_name', 'fullName', 'name']);
  const first = pick(nested, ['first_name', 'firstName']);
  const last = pick(nested, ['last_name', 'lastName']);
  const name = full ?? ([first, last].filter(Boolean).join(' ').trim() || undefined);
  return {
    name,
    phone: pick(nested, ['phone', 'phone_number', 'phoneNumber']),
    email: pick(nested, ['email']),
    message: pick(nested, ['message', 'last_message', 'comment', 'text']),
  };
}

/** ¿El payload parece de GoHighLevel? (para marcar la fuente aunque usen el genérico) */
function looksLikeGhl(body: Record<string, unknown>): boolean {
  return [
    'contact_id',
    'customData',
    'workflow',
    'location',
    'contact_type',
    'date_created',
  ].some((k) => k in body);
}

/** Primer valor no vacío para alguna de las claves, recorriendo varios objetos. */
function pick(
  sources: (Record<string, unknown> | undefined)[],
  keys: string[],
): string | undefined {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) {
      const v = str(src[k]);
      if (v) return v;
    }
  }
  return undefined;
}

/** Normaliza a string no vacío (acepta números); si no, undefined. */
function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * Mapea un payload típico de GoHighLevel (Workflow → Webhook saliente con el
 * trigger "Facebook Lead Form Submitted") a nuestro formato de intake.
 */
function mapGhl(body: Record<string, unknown>, token: string): IntakeInput {
  const f = extractLeadFields(body);
  const customData = (body.customData ?? {}) as Record<string, unknown>;
  return {
    token,
    name: f.name,
    phone: f.phone,
    email: f.email,
    channel: 'whatsapp',
    source: 'ghl',
    source_detail:
      str(body.source) ??
      str(customData.source) ??
      str(body.form_name) ??
      str(body.page_name),
    campaign:
      str(body.campaign) ??
      str(customData.campaign) ??
      str(body.utm_campaign) ??
      str(body.ad_id),
    proactive: true,
    raw: body,
  };
}
