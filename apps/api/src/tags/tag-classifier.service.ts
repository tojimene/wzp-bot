import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { SupabaseService } from '../supabase/supabase.service';
import { SetterConfigService } from '../setter/setter-config.service';
import { TagsService } from './tags.service';
import type { TagDefinition } from './tags.types';

type StoredMessage = { role: string; content: string };

/** Cuántos mensajes recientes damos al modelo como contexto. */
const HISTORY_LIMIT = 24;

@Injectable()
export class TagClassifierService {
  private readonly logger = new Logger(TagClassifierService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly openrouter: OpenRouterService,
    private readonly setterConfig: SetterConfigService,
    private readonly tags: TagsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Analiza a fondo la conversación y aplica las etiquetas cuyo criterio se
   * cumple. Pensado para llamarse tras cada turno (fire-and-forget). Reglas:
   *  - Solo AÑADE etiquetas (nunca quita).
   *  - No re-aplica etiquetas que un humano quitó (respeta lo manual).
   *  - Debounce: no re-analiza si no hay mensajes nuevos desde el último tag.
   *  - Respeta el tope diario de tokens de la organización.
   */
  async maybeTag(orgId: string, conversationId: string): Promise<void> {
    try {
      const { data: conv } = await this.supabase.admin
        .from('conversations')
        .select('id, contact_name, tagged_at, last_message_at')
        .eq('id', conversationId)
        .eq('organization_id', orgId)
        .maybeSingle();
      if (!conv) return;

      // Debounce: si no ha entrado ningún mensaje desde el último etiquetado, salimos.
      const taggedAt = conv.tagged_at ? new Date(conv.tagged_at as string).getTime() : 0;
      const lastMsg = conv.last_message_at
        ? new Date(conv.last_message_at as string).getTime()
        : Date.now();
      if (taggedAt && lastMsg <= taggedAt) return;

      // Catálogo de etiquetas auto-aplicables de la organización.
      const defs = (await this.tags.listDefinitions(orgId)).filter((d) => d.ai_enabled);
      if (defs.length === 0) return;

      const applied = await this.tags.appliedTagIds(conversationId);
      const removed = await this.tags.removedTagIds(conversationId);
      // Candidatas: ni aplicadas ya, ni suprimidas por un humano.
      const candidates = defs.filter((d) => !applied.has(d.id) && !removed.has(d.id));

      // Marcamos el debounce aunque no haya candidatas (evita re-consultar en balde).
      await this.markTagged(conversationId);
      if (candidates.length === 0) return;

      // Control de coste: si la org superó su tope de tokens del día, no etiquetamos.
      const cfg = await this.setterConfig.getOrCreate(orgId);
      if (cfg.daily_token_limit && cfg.daily_token_limit > 0) {
        const used = await this.openrouter.tokensUsedToday(orgId);
        if (used >= cfg.daily_token_limit) return;
      }

      const { data: history } = await this.supabase.admin
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT);
      const recent = ((history ?? []) as StoredMessage[]).reverse();
      if (recent.length === 0) return;

      const chosen = await this.classify(
        orgId,
        conversationId,
        conv.contact_name as string | null,
        recent,
        candidates,
        cfg.offer,
        cfg.qualification_criteria,
        cfg.objective,
      );
      // Filtro de seguridad: solo ids de candidatas válidas.
      const valid = chosen.filter((id) => candidates.some((c) => c.id === id));
      if (valid.length === 0) return;

      await this.tags.applyTags(orgId, conversationId, valid, 'ai', null);
      this.logger.log(
        `Auto-etiquetado (conv ${conversationId}): +${valid.length} etiqueta(s)`,
      );
    } catch (err) {
      this.logger.warn(`Auto-etiquetado falló (conv ${conversationId}): ${String(err)}`);
    }
  }

  private async markTagged(conversationId: string): Promise<void> {
    await this.supabase.admin
      .from('conversations')
      .update({ tagged_at: new Date().toISOString() })
      .eq('id', conversationId);
  }

  private async classify(
    orgId: string,
    conversationId: string,
    contactName: string | null,
    messages: StoredMessage[],
    candidates: TagDefinition[],
    offer?: string | null,
    qualification?: string | null,
    objective?: string | null,
  ): Promise<string[]> {
    const transcript = messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'contact' ? 'LEAD' : 'NOSOTROS'}: ${m.content}`)
      .join('\n');

    const catalog = candidates
      .map(
        (c) =>
          `- id: ${c.id}\n  nombre: ${c.name}\n  criterio: ${
            (c.description ?? '').trim() || '(sin criterio explícito; usa el nombre como guía)'
          }`,
      )
      .join('\n');

    const system = [
      'Eres un analista de ventas experto. Tu tarea es ETIQUETAR una conversación',
      'entre un setter y un lead, aplicando ÚNICAMENTE las etiquetas cuyo criterio',
      'se cumple con CLARIDAD según lo que dice la conversación.',
      '',
      'CONTEXTO DEL NEGOCIO:',
      offer ? `Oferta: ${offer}` : '',
      qualification ? `Criterios de cualificación: ${qualification}` : '',
      objective ? `Objetivo del setter: ${objective}` : '',
      '',
      'ETIQUETAS DISPONIBLES (elige solo las que apliquen):',
      catalog,
      '',
      'REGLAS:',
      '- Analiza a fondo TODA la conversación, no solo el último mensaje.',
      '- Aplica una etiqueta SOLO si su criterio se cumple de forma evidente.',
      '- Es válido no devolver ninguna etiqueta si ninguna aplica con claridad.',
      '- No inventes ids: usa exactamente los "id" de la lista.',
      '',
      'Devuelve EXCLUSIVAMENTE JSON válido (sin markdown) con esta forma:',
      '{"tags": ["<id>", "<id>"]}',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await this.openrouter.chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `CONVERSACIÓN CON ${contactName ?? 'el lead'}:\n\n${transcript}`,
        },
      ],
      {
        model: this.config.get<string>('OPENROUTER_DEFAULT_MODEL') ?? undefined,
        temperature: 0,
        maxTokens: 300,
        orgId,
        conversationId,
        purpose: 'tag',
      },
    );

    return this.parseIds(raw);
  }

  private parseIds(raw: string): string[] {
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
      const obj = JSON.parse(json) as { tags?: unknown };
      if (!Array.isArray(obj.tags)) return [];
      return obj.tags.map((t) => String(t)).filter(Boolean);
    } catch {
      return [];
    }
  }
}
