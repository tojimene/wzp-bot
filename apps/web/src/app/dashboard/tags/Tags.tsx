"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { STAGE_LABEL, STAGES, type Stage, type Tag } from "./types";
import styles from "./tags.module.css";

const PRESET_COLORS = [
  "#6366f1",
  "#22c55e",
  "#3b82f6",
  "#eab308",
  "#a855f7",
  "#f87171",
  "#14b8a6",
  "#f97316",
];

type Draft = {
  name: string;
  color: string;
  description: string;
  set_stage: "" | Stage;
  ai_enabled: boolean;
};

const EMPTY: Draft = {
  name: "",
  color: PRESET_COLORS[0],
  description: "",
  set_stage: "",
  ai_enabled: true,
};

export default function Tags() {
  const [items, setItems] = useState<Tag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<Tag[]>("/api/tags"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setEditingId(null);
    setDraft(EMPTY);
  }

  function startEdit(tag: Tag) {
    setEditingId(tag.id);
    setDraft({
      name: tag.name,
      color: tag.color,
      description: tag.description ?? "",
      set_stage: tag.set_stage ?? "",
      ai_enabled: tag.ai_enabled,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function save() {
    if (!draft.name.trim()) {
      setError("Ponle un nombre a la etiqueta");
      return;
    }
    setBusy(true);
    setError(null);
    const body = JSON.stringify({
      name: draft.name.trim(),
      color: draft.color,
      description: draft.description.trim() || null,
      set_stage: draft.set_stage || null,
      ai_enabled: draft.ai_enabled,
    });
    try {
      if (editingId) {
        await apiFetch(`/api/tags/${editingId}`, { method: "PATCH", body });
      } else {
        await apiFetch("/api/tags", { method: "POST", body });
      }
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(tag: Tag) {
    if (!confirm(`¿Eliminar la etiqueta "${tag.name}"? Se quitará de todas las conversaciones.`))
      return;
    setBusy(true);
    try {
      await apiFetch(`/api/tags/${tag.id}`, { method: "DELETE" });
      if (editingId === tag.id) resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAi(tag: Tag) {
    setBusy(true);
    try {
      await apiFetch(`/api/tags/${tag.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ai_enabled: !tag.ai_enabled }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          {editingId ? "Editar etiqueta" : "Nueva etiqueta"}
        </h2>
        <div className={styles.form}>
          <div className={styles.formRow}>
            <label className={styles.field}>
              Color
              <input
                type="color"
                className={styles.color}
                value={draft.color}
                onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              />
            </label>
            <label className={styles.field} style={{ flex: 1 }}>
              Nombre
              <input
                className={styles.input}
                style={{ width: "100%" }}
                placeholder="p.ej. Llamada agendada"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              Mueve la etapa a
              <select
                className={styles.select}
                value={draft.set_stage}
                onChange={(e) =>
                  setDraft({ ...draft, set_stage: e.target.value as "" | Stage })
                }
              >
                <option value="">— No cambiar la etapa —</option>
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={styles.field}>
            Criterio para la IA (¿cuándo debe aplicar esta etiqueta?)
            <textarea
              className={styles.textarea}
              rows={3}
              placeholder="p.ej. El lead confirma explícitamente que ya reservó/agendó la llamada, o acepta un hueco concreto."
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>

          <div className={styles.formRow}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.ai_enabled}
                onChange={(e) => setDraft({ ...draft, ai_enabled: e.target.checked })}
              />
              La IA puede aplicarla automáticamente
            </label>
            <div style={{ flex: 1 }} />
            {editingId && (
              <button className={styles.ghostBtn} onClick={resetForm} disabled={busy}>
                Cancelar
              </button>
            )}
            <button className={styles.primaryBtn} onClick={save} disabled={busy}>
              {editingId ? "Guardar cambios" : "Crear etiqueta"}
            </button>
          </div>
        </div>
      </section>

      <ul className={styles.list}>
        {items.length === 0 && (
          <p className={styles.hint}>
            Aún no tienes etiquetas. Crea la primera arriba (p.ej. &quot;Llamada
            agendada&quot;, &quot;Perdido&quot;, &quot;Interés alto&quot;).
          </p>
        )}
        {items.map((tag) => (
          <li key={tag.id} className={styles.item}>
            <div className={styles.itemInfo}>
              <span className={styles.itemName}>
                <span className={styles.dot} style={{ background: tag.color }} />
                {tag.name}
                <span className={`${styles.chip} ${tag.ai_enabled ? styles.chipOn : styles.chipOff}`}>
                  {tag.ai_enabled ? "IA" : "manual"}
                </span>
                {tag.set_stage && (
                  <span className={`${styles.chip} ${styles.chipStage}`}>
                    → {STAGE_LABEL[tag.set_stage]}
                  </span>
                )}
              </span>
              {tag.description && <span className={styles.hint}>{tag.description}</span>}
            </div>
            <div className={styles.actions}>
              <button className={styles.ghostBtn} onClick={() => toggleAi(tag)} disabled={busy}>
                {tag.ai_enabled ? "Desactivar IA" : "Activar IA"}
              </button>
              <button className={styles.ghostBtn} onClick={() => startEdit(tag)} disabled={busy}>
                Editar
              </button>
              <button className={styles.dangerBtn} onClick={() => remove(tag)} disabled={busy}>
                Eliminar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
