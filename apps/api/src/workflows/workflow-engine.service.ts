import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { MessagingService } from '../messaging/messaging.service';
import { WorkflowsService, type WorkflowRow } from './workflows.service';
import { renderMessage, resolveVariables } from './variables';
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowTrigger,
} from './workflows.types';

/** Lock obsoleto: un run "en curso" más de esto se reclama. */
const LOCK_STALE_MS = 3 * 60 * 1000;
const RUN_BATCH = 20;
/** Tope de nodos "instantáneos" procesados de una vez (evita bucles infinitos). */
const MAX_STEPS = 30;

type RunRow = {
  id: string;
  organization_id: string;
  workflow_id: string;
  conversation_id: string;
  status: string;
  current_node_id: string | null;
  next_run_at: string | null;
  context: Record<string, unknown>;
};

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly workflows: WorkflowsService,
    private readonly messaging: MessagingService,
  ) {}

  // ===========================================================================
  //  ARRANQUE
  // ===========================================================================

  /**
   * Inscribe una conversación en el workflow ACTIVO que coincida con el trigger.
   * Devuelve true si se inició un run. No duplica (índice único por conv+wf).
   */
  async startForConversation(
    orgId: string,
    conversationId: string,
    trigger: WorkflowTrigger,
    opts: { stage?: string } = {},
  ): Promise<boolean> {
    const wf = await this.workflows.findActiveByTrigger(orgId, trigger);
    if (!wf) return false;

    // Trigger por estado: solo si coincide el configurado.
    if (trigger === 'stage') {
      const want = (wf.trigger_config?.stage as string | undefined) ?? null;
      if (want && opts.stage && want !== opts.stage) return false;
    }

    return this.enroll(wf, conversationId);
  }

  /** Inscribe explícitamente una conversación en un workflow concreto (manual). */
  async enrollById(orgId: string, workflowId: string, conversationId: string): Promise<boolean> {
    const wf = await this.workflows.get(orgId, workflowId);
    // Seguridad (IDOR): el `conversationId` viene del cliente. Confirmamos que la
    // conversación pertenece a la MISMA organización antes de inscribirla.
    const { data: conv } = await this.supabase.admin
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!conv) {
      throw new NotFoundException('Conversación no encontrada');
    }
    return this.enroll(wf, conversationId);
  }

  private async enroll(wf: WorkflowRow, conversationId: string): Promise<boolean> {
    const def = normalizeDefinition(wf.definition);
    const entry = entryNodeId(def);
    if (!entry) {
      this.logger.warn(`Workflow ${wf.id} sin nodo de inicio; no se inscribe.`);
      return false;
    }

    const { error } = await this.supabase.admin.from('workflow_runs').insert({
      organization_id: wf.organization_id,
      workflow_id: wf.id,
      conversation_id: conversationId,
      status: 'active',
      current_node_id: entry,
      next_run_at: new Date().toISOString(),
      context: { resume_after_hours: wf.resume_after_hours ?? null },
    });
    if (error) {
      // 23505 = ya existe un run vivo para esta conv+workflow (índice único).
      if ((error as { code?: string }).code === '23505') return false;
      this.logger.error(`No se pudo iniciar el workflow ${wf.id}: ${error.message}`);
      return false;
    }
    this.logger.log(`Workflow ${wf.id} iniciado para conv ${conversationId}`);
    return true;
  }

  // ===========================================================================
  //  CRON: drena runs vencidos + reanuda pausados
  // ===========================================================================

  async processDueRuns(limit = RUN_BATCH): Promise<number> {
    await this.resumePaused();

    const nowIso = new Date().toISOString();
    const staleIso = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const { data: due } = await this.supabase.admin
      .from('workflow_runs')
      .select('id, organization_id, workflow_id, conversation_id, status, current_node_id, next_run_at, context')
      .eq('status', 'active')
      .not('next_run_at', 'is', null)
      .lte('next_run_at', nowIso)
      .or(`locked_at.is.null,locked_at.lt.${staleIso}`)
      .order('next_run_at', { ascending: true })
      .limit(limit);

    if (!due || due.length === 0) return 0;

    let handled = 0;
    for (const run of due as RunRow[]) {
      // Lock atómico.
      const { data: locked } = await this.supabase.admin
        .from('workflow_runs')
        .update({ locked_at: nowIso })
        .eq('id', run.id)
        .eq('status', 'active')
        .or(`locked_at.is.null,locked_at.lt.${staleIso}`)
        .select('id')
        .maybeSingle();
      if (!locked) continue;

      try {
        await this.processRun(run);
        handled++;
      } catch (err) {
        this.logger.error(`Error en run ${run.id}: ${String(err)}`);
        await this.supabase.admin
          .from('workflow_runs')
          .update({ status: 'failed', last_error: String(err), locked_at: null })
          .eq('id', run.id);
      }
    }
    return handled;
  }

  /** Reanuda runs pausados cuyo lead lleva en silencio >= resume_after_hours. */
  private async resumePaused(): Promise<void> {
    const { data: paused } = await this.supabase.admin
      .from('workflow_runs')
      .select('id, conversation_id, context')
      .eq('status', 'paused')
      .limit(50);
    if (!paused || paused.length === 0) return;

    for (const run of paused as RunRow[]) {
      const hours = Number(run.context?.resume_after_hours ?? 0);
      if (!hours || hours <= 0) continue;
      const { data: conv } = await this.supabase.admin
        .from('conversations')
        .select('last_inbound_at, followups_paused')
        .eq('id', run.conversation_id)
        .maybeSingle();
      if (!conv || conv.followups_paused) continue;
      const lastIn = conv.last_inbound_at ? new Date(conv.last_inbound_at as string).getTime() : 0;
      if (!lastIn) continue;
      if (Date.now() - lastIn >= hours * 3600_000) {
        await this.supabase.admin
          .from('workflow_runs')
          .update({ status: 'active', next_run_at: new Date().toISOString(), locked_at: null })
          .eq('id', run.id)
          .eq('status', 'paused');
      }
    }
  }

  // ===========================================================================
  //  EJECUCIÓN DE UN RUN
  // ===========================================================================

  private async processRun(run: RunRow): Promise<void> {
    const wf = await this.getWorkflow(run.organization_id, run.workflow_id);
    if (!wf || !wf.is_active) {
      await this.finish(run.id, 'stopped');
      return;
    }
    const def = normalizeDefinition(wf.definition);

    // Si el lead ya agendó/está pausado por GHL, no seguimos persiguiéndolo.
    const conv = await this.loadConversation(run.conversation_id);
    if (!conv) {
      await this.finish(run.id, 'stopped');
      return;
    }
    if (conv.row.followups_paused) {
      await this.setStatus(run.id, 'paused');
      return;
    }

    let node = getNode(def, run.current_node_id);
    let steps = 0;

    while (node && steps++ < MAX_STEPS) {
      switch (node.type) {
        case 'start': {
          node = this.nextNode(def, node.id);
          break;
        }
        case 'message': {
          const text = renderMessage(
            node.data?.text ?? '',
            resolveVariables({ conversation: conv.row, lead: conv.lead }),
          );
          if (text) {
            await this.messaging.enqueueWorkflowSend({
              orgId: run.organization_id,
              conversationId: run.conversation_id,
              content: text,
            });
          }
          node = this.nextNode(def, node.id);
          break;
        }
        case 'wait': {
          const ms = waitMs(node.data?.amount, node.data?.unit);
          const target = this.nextNodeId(def, node.id);
          if (!target) {
            await this.finish(run.id, 'completed');
            return;
          }
          await this.schedule(run.id, target, Date.now() + ms);
          return;
        }
        case 'if_replied': {
          const replied = hasReplied(conv.row);
          node = this.nextNode(def, node.id, replied ? 'yes' : 'no');
          break;
        }
        case 'if_stage': {
          const match = (conv.row.stage as string | null) === (node.data?.stage ?? '');
          node = this.nextNode(def, node.id, match ? 'yes' : 'no');
          break;
        }
        case 'stop': {
          await this.applyStop(run.conversation_id, node);
          await this.finish(run.id, 'stopped');
          return;
        }
        case 'ai_handoff': {
          await this.supabase.admin
            .from('conversations')
            .update({ ai_enabled: true })
            .eq('id', run.conversation_id);
          await this.finish(run.id, 'completed');
          return;
        }
        default: {
          node = this.nextNode(def, node.id);
        }
      }
    }

    // Sin más nodos (o tope de pasos): terminamos.
    await this.finish(run.id, 'completed');
  }

  private async applyStop(conversationId: string, node: WorkflowNode): Promise<void> {
    const update: Record<string, unknown> = {};
    if (node.data?.pause_followups) update.followups_paused = true;
    if (node.data?.set_stage) update.stage = node.data.set_stage;
    if (Object.keys(update).length === 0) return;
    await this.supabase.admin.from('conversations').update(update).eq('id', conversationId);
  }

  // ---- helpers de estado ----

  private async schedule(runId: string, currentNodeId: string, at: number): Promise<void> {
    await this.supabase.admin
      .from('workflow_runs')
      .update({
        current_node_id: currentNodeId,
        next_run_at: new Date(at).toISOString(),
        locked_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', runId);
  }

  private async finish(runId: string, status: 'completed' | 'stopped' | 'failed'): Promise<void> {
    await this.supabase.admin
      .from('workflow_runs')
      .update({ status, next_run_at: null, locked_at: null, updated_at: new Date().toISOString() })
      .eq('id', runId);
  }

  private async setStatus(runId: string, status: string): Promise<void> {
    await this.supabase.admin
      .from('workflow_runs')
      .update({ status, locked_at: null, updated_at: new Date().toISOString() })
      .eq('id', runId);
  }

  // ---- helpers de grafo ----

  private nextNode(
    def: WorkflowDefinition,
    fromId: string,
    handle?: string,
  ): WorkflowNode | null {
    const id = this.nextNodeId(def, fromId, handle);
    return id ? getNode(def, id) : null;
  }

  private nextNodeId(def: WorkflowDefinition, fromId: string, handle?: string): string | null {
    const edges = def.edges.filter((e) => e.source === fromId);
    if (edges.length === 0) return null;
    if (handle !== undefined) {
      const match = edges.find((e) => (e.sourceHandle ?? 'yes') === handle);
      return match?.target ?? null;
    }
    return edges[0].target ?? null;
  }

  private async getWorkflow(orgId: string, id: string): Promise<WorkflowRow | null> {
    try {
      return await this.workflows.get(orgId, id);
    } catch {
      return null;
    }
  }

  private async loadConversation(id: string) {
    const { data: row } = await this.supabase.admin
      .from('conversations')
      .select(
        'id, contact_name, contact_handle, stage, source, campaign, last_inbound_at, last_outbound_at, followups_paused',
      )
      .eq('id', id)
      .maybeSingle();
    if (!row) return null;
    const { data: lead } = await this.supabase.admin
      .from('leads')
      .select('name, phone, email, source, campaign, fields')
      .eq('conversation_id', id)
      .maybeSingle();
    return { row: row as Record<string, unknown>, lead: (lead as Record<string, unknown>) ?? null };
  }
}

// =============================================================================
//  Utilidades puras
// =============================================================================

function normalizeDefinition(def: unknown): WorkflowDefinition {
  const d = (def as WorkflowDefinition) ?? { nodes: [], edges: [] };
  return { nodes: Array.isArray(d.nodes) ? d.nodes : [], edges: Array.isArray(d.edges) ? d.edges : [] };
}

function getNode(def: WorkflowDefinition, id: string | null): WorkflowNode | null {
  if (!id) return null;
  return def.nodes.find((n) => n.id === id) ?? null;
}

/** Nodo de entrada: el 'start', o el primero sin aristas entrantes. */
function entryNodeId(def: WorkflowDefinition): string | null {
  const start = def.nodes.find((n) => n.type === 'start');
  if (start) return start.id;
  const targets = new Set(def.edges.map((e) => e.target));
  const root = def.nodes.find((n) => !targets.has(n.id));
  return root?.id ?? def.nodes[0]?.id ?? null;
}

function waitMs(amount?: number, unit?: string): number {
  const n = Math.max(0, Number(amount ?? 0));
  const mult = unit === 'days' ? 86_400_000 : unit === 'hours' ? 3_600_000 : 60_000;
  return n * mult;
}

/** ¿El último mensaje del lead es más nuevo que nuestro último envío? */
function hasReplied(conv: Record<string, unknown>): boolean {
  const inAt = conv.last_inbound_at ? new Date(conv.last_inbound_at as string).getTime() : 0;
  const outAt = conv.last_outbound_at ? new Date(conv.last_outbound_at as string).getTime() : 0;
  return inAt > outAt;
}
