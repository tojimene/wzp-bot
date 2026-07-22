import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { CryptoService } from '../common/crypto.service';
import { assertSafeWebhookUrl } from '../common/url-safety';

const COLS =
  'organization_id, intake_token, manychat_api_key, default_channel_id, proactive_enabled, ghl_webhook_url';

export type Integration = {
  organization_id: string;
  intake_token: string;
  manychat_api_key: string | null;
  default_channel_id: string | null;
  proactive_enabled: boolean;
  ghl_webhook_url: string | null;
};

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  /** Descifra los secretos almacenados antes de devolver la fila. */
  private decode(row: Integration): Integration {
    return { ...row, manychat_api_key: this.crypto.decrypt(row.manychat_api_key) };
  }

  async getOrCreate(orgId: string): Promise<Integration> {
    const { data } = await this.supabase.admin
      .from('integrations')
      .select(COLS)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (data) return this.decode(data as Integration);

    const { data: created, error } = await this.supabase.admin
      .from('integrations')
      .insert({ organization_id: orgId })
      .select(COLS)
      .single();
    if (error) throw error;
    return this.decode(created as Integration);
  }

  async update(
    orgId: string,
    patch: {
      manychat_api_key?: string;
      default_channel_id?: string | null;
      proactive_enabled?: boolean;
      ghl_webhook_url?: string;
    },
  ): Promise<Integration> {
    await this.getOrCreate(orgId);
    const update: Record<string, unknown> = {};
    // Ciframos la API key en reposo (AES-256-GCM). Cadena vacía = borrar.
    if (typeof patch.manychat_api_key === 'string') {
      const v = patch.manychat_api_key.trim();
      update.manychat_api_key = v ? this.crypto.encrypt(v) : null;
    }
    if (patch.default_channel_id !== undefined) update.default_channel_id = patch.default_channel_id;
    if (typeof patch.proactive_enabled === 'boolean') update.proactive_enabled = patch.proactive_enabled;
    // URL del Inbound Webhook de GHL (destino de salida). Cadena vacía = borrar.
    // Validación anti-SSRF: exigimos https y bloqueamos hosts internos.
    if (typeof patch.ghl_webhook_url === 'string') {
      const v = patch.ghl_webhook_url.trim();
      update.ghl_webhook_url = v ? assertSafeWebhookUrl(v) : null;
    }

    const { data, error } = await this.supabase.admin
      .from('integrations')
      .update(update)
      .eq('organization_id', orgId)
      .select(COLS)
      .single();
    if (error) throw error;
    return this.decode(data as Integration);
  }

  async rotateToken(orgId: string): Promise<Integration> {
    await this.getOrCreate(orgId);
    const token = this.crypto.token(32); // 64 chars hex, criptográficamente seguro
    const { data, error } = await this.supabase.admin
      .from('integrations')
      .update({ intake_token: token })
      .eq('organization_id', orgId)
      .select(COLS)
      .single();
    if (error) throw error;
    return this.decode(data as Integration);
  }

  /** Devuelve las URLs listas para pegar en GHL/ManyChat/Zapier. */
  buildUrls(token: string) {
    const base = (this.config.get<string>('WEBHOOK_BASE_URL') ?? 'https://TU-DOMINIO').replace(/\/$/, '');
    return {
      lead_intake: `${base}/api/leads/intake?token=${token}`,
      ghl_lead: `${base}/api/leads/ghl?token=${token}`,
      ghl_appointment: `${base}/api/webhooks/ghl/appointment?token=${token}`,
      manychat_dynamic: `${base}/api/integrations/manychat/dynamic?token=${token}`,
    };
  }
}
