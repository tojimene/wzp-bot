/**
 * Tipos del árbol de workflows (formato compatible con React Flow en el front).
 * La definición se guarda como JSON en `workflows.definition`.
 */

export type WorkflowTrigger = 'lead_created' | 'manual' | 'stage';

export type NodeType =
  | 'start'
  | 'message'
  | 'wait'
  | 'if_replied'
  | 'if_stage'
  | 'stop'
  | 'ai_handoff';

export type WaitUnit = 'minutes' | 'hours' | 'days';

/** Datos específicos de cada nodo (según su tipo). */
export type WorkflowNodeData = {
  /** message: texto a enviar (admite variables {{name}} / {name}). */
  text?: string;
  /** wait: cantidad + unidad de espera. */
  amount?: number;
  unit?: WaitUnit;
  /** if_stage: estado con el que comparar. */
  stage?: string;
  /** stop: cambiar de estado y/o pausar seguimientos al terminar. */
  set_stage?: string;
  pause_followups?: boolean;
  label?: string;
};

export type WorkflowNode = {
  id: string;
  type: NodeType;
  data?: WorkflowNodeData;
  position?: { x: number; y: number };
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  /** Rama de salida en nodos condicionales: 'yes' | 'no' (u otra etiqueta). */
  sourceHandle?: string | null;
};

export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};
