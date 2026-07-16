export type NodeKind =
  | "start"
  | "message"
  | "wait"
  | "if_replied"
  | "if_stage"
  | "stop"
  | "ai_handoff";

export type WfNodeData = {
  kind: NodeKind;
  text?: string;
  amount?: number;
  unit?: "minutes" | "hours" | "days";
  stage?: string;
  set_stage?: string;
  pause_followups?: boolean;
  label?: string;
};

export type WfDefNode = {
  id: string;
  type: NodeKind;
  data?: Omit<WfNodeData, "kind">;
  position?: { x: number; y: number };
};

export type WfDefEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
};

export type WorkflowDefinition = { nodes: WfDefNode[]; edges: WfDefEdge[] };

export type Workflow = {
  id: string;
  name: string;
  trigger: "lead_created" | "manual" | "stage";
  trigger_config: Record<string, unknown>;
  is_active: boolean;
  resume_after_hours: number | null;
  definition: WorkflowDefinition;
  created_at: string;
  updated_at: string;
};

export const TRIGGER_LABEL: Record<Workflow["trigger"], string> = {
  lead_created: "Cuando entra un lead",
  manual: "Manual",
  stage: "Al cambiar de estado",
};

export const STAGES = [
  "new",
  "qualifying",
  "qualified",
  "not_qualified",
  "call_scheduled",
  "won",
  "lost",
];
