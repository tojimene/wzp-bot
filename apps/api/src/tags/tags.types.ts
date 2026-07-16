export const FUNNEL_STAGES = [
  'new',
  'qualifying',
  'qualified',
  'not_qualified',
  'call_scheduled',
  'won',
  'lost',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type TagDefinition = {
  id: string;
  organization_id: string;
  name: string;
  color: string;
  description: string | null;
  set_stage: FunnelStage | null;
  ai_enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Etiqueta aplicada a una conversación, con datos de la definición para pintar. */
export type AppliedTag = {
  tag_id: string;
  name: string;
  color: string;
  source: 'ai' | 'human';
  created_at: string;
};
