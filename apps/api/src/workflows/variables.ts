/**
 * Resolución y sustitución de variables en los mensajes de un workflow.
 *
 * Soporta doble sintaxis: {{variable}} (estilo Mustache) y {variable}. Las
 * variables salen de la conversación y del lead del CRM (incluidos los campos
 * personalizados del formulario en `leads.fields`).
 */

export type VariableSource = {
  conversation?: Record<string, unknown> | null;
  lead?: Record<string, unknown> | null;
};

/** Devuelve un mapa plano de variables disponibles (claves en minúscula). */
export function resolveVariables(src: VariableSource): Record<string, string> {
  const vars: Record<string, string> = {};
  const set = (key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (v.trim() === '') return;
    vars[key.toLowerCase()] = v;
  };

  const conv = src.conversation ?? {};
  const lead = src.lead ?? {};

  const fullName = (lead.name as string) ?? (conv.contact_name as string) ?? '';
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  set('name', first);
  set('first_name', first);
  set('nombre', first);
  set('full_name', fullName.trim());
  set('nombre_completo', fullName.trim());

  set('email', lead.email);
  set('phone', lead.phone ?? conv.contact_handle);
  set('telefono', lead.phone ?? conv.contact_handle);
  set('source', lead.source ?? conv.source);
  set('fuente', lead.source ?? conv.source);
  set('campaign', lead.campaign ?? conv.campaign);
  set('campana', lead.campaign ?? conv.campaign);
  set('stage', conv.stage);
  set('estado', conv.stage);

  // Campos personalizados del formulario (GHL/ManyChat/etc.).
  const fields = (lead.fields as Record<string, unknown> | null) ?? null;
  if (fields && typeof fields === 'object') {
    for (const [k, v] of Object.entries(fields)) set(k, v);
  }

  return vars;
}

/** Sustituye {{var}} y {var} en el texto. Variables desconocidas → cadena vacía. */
export function renderMessage(template: string, vars: Record<string, string>): string {
  if (!template) return '';
  const lookup = (name: string) => vars[name.trim().toLowerCase()] ?? '';
  return template
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, name) => lookup(name))
    .replace(/\{\s*([\w.-]+)\s*\}/g, (_m, name) => lookup(name))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
