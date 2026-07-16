"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiFetch } from "@/lib/api";
import { STAGES, type NodeKind, type Workflow } from "./types";
import styles from "./workflows.module.css";

type NodeData = {
  kind: NodeKind;
  text?: string;
  amount?: number;
  unit?: "minutes" | "hours" | "days";
  stage?: string;
  set_stage?: string;
  pause_followups?: boolean;
};

const META: Record<NodeKind, { label: string; branch?: boolean; terminal?: boolean }> = {
  start: { label: "Inicio" },
  message: { label: "Enviar mensaje" },
  wait: { label: "Esperar" },
  if_replied: { label: "¿Respondió?", branch: true },
  if_stage: { label: "Según estado", branch: true },
  stop: { label: "Detener", terminal: true },
  ai_handoff: { label: "Pasar a IA", terminal: true },
};

const PALETTE: NodeKind[] = ["message", "wait", "if_replied", "if_stage", "stop", "ai_handoff"];

/** Variables disponibles para insertar en los mensajes. */
const VARIABLES: { value: string; label: string }[] = [
  { value: "name", label: "Nombre (pila)" },
  { value: "first_name", label: "Nombre (pila)" },
  { value: "full_name", label: "Nombre completo" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Teléfono" },
  { value: "source", label: "Fuente" },
  { value: "campaign", label: "Campaña" },
  { value: "stage", label: "Estado" },
];

const V_GAP_Y = 150;
const V_GAP_X = 220;

const isTerminal = (k: NodeKind) => META[k].terminal === true;
const isBranch = (k: NodeKind) => META[k].branch === true;

function summarize(d: NodeData): string {
  switch (d.kind) {
    case "message":
      return d.text ? (d.text.length > 60 ? d.text.slice(0, 60) + "…" : d.text) : "(sin texto)";
    case "wait":
      return `${d.amount ?? 0} ${d.unit ?? "minutes"}`;
    case "if_replied":
      return "sí / no";
    case "if_stage":
      return d.stage ? `= ${d.stage}` : "(elige estado)";
    case "stop":
      return [d.pause_followups ? "pausar" : null, d.set_stage ? `→ ${d.set_stage}` : null]
        .filter(Boolean)
        .join(" · ") || "fin";
    case "ai_handoff":
      return "la IA responde";
    default:
      return "";
  }
}

function WfNode({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const meta = META[d.kind];
  return (
    <div className={`${styles.node} ${selected ? styles.nodeSel : ""}`} data-kind={d.kind}>
      {d.kind !== "start" && <Handle type="target" position={Position.Top} />}
      <div className={styles.nodeTitle}>{meta.label}</div>
      <div className={styles.nodeBody}>{summarize(d)}</div>
      {meta.branch ? (
        <>
          <Handle id="yes" type="source" position={Position.Bottom} style={{ left: "28%" }} />
          <Handle id="no" type="source" position={Position.Bottom} style={{ left: "72%" }} />
          <span className={styles.handleYes}>sí</span>
          <span className={styles.handleNo}>no</span>
        </>
      ) : (
        !meta.terminal && <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}

const nodeTypes = { wf: WfNode };

/** Nodo más abajo del lienzo (para encadenar nuevos nodos si no hay selección). */
function lowestNode(nodes: Node[]): Node | undefined {
  if (nodes.length === 0) return undefined;
  return nodes.reduce((a, b) => (b.position.y > a.position.y ? b : a));
}

/**
 * Handle libre del nodo de origen para auto-conectar:
 *   - null      → salida directa (nodos no condicionales), si está libre.
 *   - 'yes'/'no'→ rama libre en nodos condicionales.
 *   - undefined → no hay salida libre (no se auto-conecta).
 */
function freeHandle(anchor: Node, edges: Edge[]): string | null | undefined {
  const kind = (anchor.data as NodeData).kind;
  const has = (h: string | null) =>
    edges.some((e) => e.source === anchor.id && (e.sourceHandle ?? null) === h);
  if (isBranch(kind)) {
    if (!has("yes")) return "yes";
    if (!has("no")) return "no";
    return undefined;
  }
  return has(null) ? undefined : null;
}

function defToFlow(wf: Workflow): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = (wf.definition?.nodes ?? []).map((n, i) => ({
    id: n.id,
    type: "wf",
    position: n.position ?? { x: 250, y: 40 + i * 130 },
    data: { ...(n.data ?? {}), kind: n.type } as NodeData,
  }));
  const edges: Edge[] = (wf.definition?.edges ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    label: e.sourceHandle === "yes" ? "sí" : e.sourceHandle === "no" ? "no" : undefined,
  }));
  return { nodes, edges };
}

function Editor({ workflow, onBack }: { workflow: Workflow; onBack: () => void }) {
  const initial = useMemo(() => defToFlow(workflow), [workflow]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(workflow.name);
  const [trigger, setTrigger] = useState(workflow.trigger);
  const [isActive, setIsActive] = useState(workflow.is_active);
  const [resumeHours, setResumeHours] = useState<string>(
    workflow.resume_after_hours ? String(workflow.resume_after_hours) : "",
  );
  const [triggerStage, setTriggerStage] = useState<string>(
    (workflow.trigger_config?.stage as string) ?? "qualified",
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (conn.source === conn.target) return; // sin auto-bucles
      setEdges((eds) => {
        // Una sola salida por handle: reemplaza la que hubiera en ese mismo punto.
        const filtered = eds.filter(
          (e) =>
            !(e.source === conn.source && (e.sourceHandle ?? null) === (conn.sourceHandle ?? null)),
        );
        return addEdge(
          {
            ...conn,
            label:
              conn.sourceHandle === "yes" ? "sí" : conn.sourceHandle === "no" ? "no" : undefined,
          },
          filtered,
        );
      });
    },
    [setEdges],
  );

  function addNode(kind: NodeKind) {
    const id = crypto.randomUUID();
    const defaults: NodeData =
      kind === "wait"
        ? { kind, amount: 1, unit: "hours" }
        : kind === "message"
          ? { kind, text: "" }
          : { kind };

    // Nodo de anclaje: el seleccionado o, si no hay, el último de la cadena.
    const anchor = nodes.find((n) => n.id === selected) ?? lowestNode(nodes);

    // Handle libre del anclaje para auto-conectar (null=directo, 'yes'/'no' en ramas).
    let handle: string | null | undefined;
    if (anchor && !isTerminal((anchor.data as NodeData).kind)) {
      handle = freeHandle(anchor, edges);
    }

    // Posición determinista: justo debajo del anclaje (desplazada según la rama).
    const base = anchor?.position ?? { x: 250, y: 40 };
    // Rama 'no' a la derecha, 'yes' a la izquierda; si no se pudo conectar
    // (salida ocupada), lo desplazamos a un lado para que no se solape.
    const dx =
      handle === "no" ? V_GAP_X : handle === "yes" ? -V_GAP_X : handle === undefined ? V_GAP_X : 0;
    const position = anchor
      ? { x: base.x + dx, y: base.y + V_GAP_Y }
      : { x: 250, y: 40 };

    setNodes((nds) => [...nds, { id, type: "wf", position, data: defaults }]);

    if (anchor && handle !== undefined) {
      setEdges((eds) =>
        addEdge(
          {
            id: `e-${anchor.id}-${id}`,
            source: anchor.id,
            target: id,
            sourceHandle: handle ?? undefined,
            label: handle === "yes" ? "sí" : handle === "no" ? "no" : undefined,
          },
          eds,
        ),
      );
    }
    setSelected(id);
  }

  /** Inserta una variable en el textarea del mensaje (en la posición del cursor). */
  function insertVariable(v: string) {
    if (!selected) return;
    const token = `{${v}}`;
    const el = textRef.current;
    const cur = (selData?.text as string) ?? "";
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + token + cur.slice(end);
    patchSelected({ text: next });
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + token.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  function patchSelected(patch: Partial<NodeData>) {
    if (!selected) return;
    setNodes((nds) =>
      nds.map((n) => (n.id === selected ? { ...n, data: { ...(n.data as NodeData), ...patch } } : n)),
    );
  }

  function deleteSelected() {
    if (!selected) return;
    setNodes((nds) => nds.filter((n) => n.id !== selected));
    setEdges((eds) => eds.filter((e) => e.source !== selected && e.target !== selected));
    setSelected(null);
  }

  function validate(): string | null {
    const emptyMsg = nodes.some(
      (n) => (n.data as NodeData).kind === "message" && !((n.data as NodeData).text ?? "").trim(),
    );
    if (emptyMsg) return "Hay un nodo de mensaje sin texto.";
    const targets = new Set(edges.map((e) => e.target));
    const orphans = nodes.filter(
      (n) => (n.data as NodeData).kind !== "start" && !targets.has(n.id),
    );
    if (orphans.length > 0) return `Hay ${orphans.length} nodo(s) sin conectar.`;
    return null;
  }

  async function save() {
    const warning = validate();
    if (warning && !confirm(`${warning}\n\n¿Guardar de todas formas?`)) return;
    setSaving(true);
    setMsg(null);
    try {
      const definition = {
        nodes: nodes.map((n) => {
          const d = n.data as NodeData;
          const { kind, ...rest } = d;
          return { id: n.id, type: kind, data: rest, position: n.position };
        }),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? null,
        })),
      };
      await apiFetch(`/api/workflows/${workflow.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          trigger,
          trigger_config: trigger === "stage" ? { stage: triggerStage } : {},
          is_active: isActive,
          resume_after_hours: resumeHours ? Number(resumeHours) : 0,
          definition,
        }),
      });
      setMsg("Guardado");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  const sel = nodes.find((n) => n.id === selected);
  const selData = sel?.data as NodeData | undefined;

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <button className={styles.ghostBtn} onClick={onBack}>
          ← Volver
        </button>
        <input
          className={styles.nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className={styles.input}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as Workflow["trigger"])}
        >
          <option value="lead_created">Cuando entra un lead</option>
          <option value="manual">Manual</option>
          <option value="stage">Al cambiar de estado</option>
        </select>
        {trigger === "stage" && (
          <select
            className={styles.input}
            value={triggerStage}
            onChange={(e) => setTriggerStage(e.target.value)}
          >
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Activo
        </label>
        <label className={styles.resume}>
          Reanudar si silencio (h)
          <input
            className={styles.smallInput}
            type="number"
            min={0}
            placeholder="off"
            value={resumeHours}
            onChange={(e) => setResumeHours(e.target.value)}
          />
        </label>
        <button className={styles.primaryBtn} onClick={save} disabled={saving}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
        {msg && <span className={styles.saveMsg}>{msg}</span>}
      </div>

      <div className={styles.canvasRow}>
        <aside className={styles.palette}>
          <span className={styles.paletteTitle}>Añadir nodo</span>
          {PALETTE.map((k) => (
            <button key={k} className={styles.paletteBtn} onClick={() => addNode(k)}>
              + {META[k].label}
            </button>
          ))}
          <p className={styles.paletteHint}>
            Variables: {"{name}"}, {"{first_name}"}, {"{email}"}, {"{phone}"}, {"{source}"} y campos
            del formulario.
          </p>
        </aside>

        <div className={styles.canvas}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            nodeTypes={nodeTypes}
            fitView
            snapToGrid
            snapGrid={[16, 16]}
            deleteKeyCode={["Backspace", "Delete"]}
            defaultEdgeOptions={{
              type: "smoothstep",
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls />
          </ReactFlow>
        </div>

        <aside className={styles.inspector}>
          {!selData ? (
            <p className={styles.hint}>Selecciona un nodo para configurarlo.</p>
          ) : (
            <>
              <span className={styles.inspectorTitle}>{META[selData.kind].label}</span>

              {selData.kind === "message" && (
                <label className={styles.field}>
                  Texto del mensaje
                  <textarea
                    ref={textRef}
                    className={styles.textarea}
                    rows={6}
                    value={selData.text ?? ""}
                    onChange={(e) => patchSelected({ text: e.target.value })}
                    placeholder="hola {name}, vi que dejaste tus datos…"
                  />
                  <div className={styles.varRow}>
                    <select
                      className={styles.input}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) insertVariable(e.target.value);
                        e.target.value = "";
                      }}
                    >
                      <option value="">+ Insertar variable…</option>
                      {VARIABLES.map((v) => (
                        <option key={v.value} value={v.value}>
                          {v.label} · {`{${v.value}}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className={styles.hint}>
                    También puedes usar campos del formulario, p.ej. {"{ciudad}"}.
                  </span>
                </label>
              )}

              {selData.kind === "wait" && (
                <div className={styles.formRow}>
                  <label className={styles.field}>
                    Cantidad
                    <input
                      className={styles.smallInput}
                      type="number"
                      min={0}
                      value={selData.amount ?? 0}
                      onChange={(e) => patchSelected({ amount: Number(e.target.value) })}
                    />
                  </label>
                  <label className={styles.field}>
                    Unidad
                    <select
                      className={styles.input}
                      value={selData.unit ?? "hours"}
                      onChange={(e) =>
                        patchSelected({ unit: e.target.value as NodeData["unit"] })
                      }
                    >
                      <option value="minutes">minutos</option>
                      <option value="hours">horas</option>
                      <option value="days">días</option>
                    </select>
                  </label>
                </div>
              )}

              {selData.kind === "if_stage" && (
                <label className={styles.field}>
                  Estado a comprobar
                  <select
                    className={styles.input}
                    value={selData.stage ?? "qualified"}
                    onChange={(e) => patchSelected({ stage: e.target.value })}
                  >
                    {STAGES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {selData.kind === "if_replied" && (
                <p className={styles.hint}>
                  Rama <strong>sí</strong> si el lead respondió, <strong>no</strong> si no.
                </p>
              )}

              {selData.kind === "stop" && (
                <>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={selData.pause_followups ?? false}
                      onChange={(e) => patchSelected({ pause_followups: e.target.checked })}
                    />
                    Pausar seguimientos
                  </label>
                  <label className={styles.field}>
                    Cambiar estado a (opcional)
                    <select
                      className={styles.input}
                      value={selData.set_stage ?? ""}
                      onChange={(e) => patchSelected({ set_stage: e.target.value })}
                    >
                      <option value="">— sin cambio —</option>
                      {STAGES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              {selData.kind === "ai_handoff" && (
                <p className={styles.hint}>Activa la IA setter para que responda a partir de aquí.</p>
              )}

              <button className={styles.dangerBtn} onClick={deleteSelected}>
                Eliminar nodo
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function WorkflowEditor(props: { workflow: Workflow; onBack: () => void }) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}
