export type Stage =
  | "new"
  | "qualifying"
  | "qualified"
  | "not_qualified"
  | "call_scheduled"
  | "won"
  | "lost";

export const STAGE_LABEL: Record<Stage, string> = {
  new: "Nuevo",
  qualifying: "Cualificando",
  qualified: "Cualificado",
  not_qualified: "No cualifica",
  call_scheduled: "Llamada agendada",
  won: "Ganado",
  lost: "Perdido",
};

export const STAGES: Stage[] = [
  "new",
  "qualifying",
  "qualified",
  "not_qualified",
  "call_scheduled",
  "won",
  "lost",
];

export type Tag = {
  id: string;
  name: string;
  color: string;
  description: string | null;
  set_stage: Stage | null;
  ai_enabled: boolean;
  sort_order: number;
};
