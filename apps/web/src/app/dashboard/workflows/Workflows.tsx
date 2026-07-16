"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import WorkflowEditor from "./WorkflowEditor";
import { TRIGGER_LABEL, type Workflow } from "./types";
import styles from "./workflows.module.css";

const STARTER_DEF = {
  nodes: [{ id: "start", type: "start", data: {}, position: { x: 250, y: 40 } }],
  edges: [],
};

export default function Workflows() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<Workflow["trigger"]>("lead_created");

  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<Workflow[]>("/api/workflows"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (!name.trim()) {
      setError("Ponle un nombre al workflow");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const wf = await apiFetch<Workflow>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({ name, trigger, definition: STARTER_DEF }),
      });
      setName("");
      await load();
      setEditing(wf);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(wf: Workflow) {
    setBusy(true);
    try {
      await apiFetch(`/api/workflows/${wf.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !wf.is_active }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(wf: Workflow) {
    if (!confirm(`¿Eliminar el workflow "${wf.name}"?`)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/workflows/${wf.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <WorkflowEditor
        workflow={editing}
        onBack={() => {
          setEditing(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className={styles.wrap}>
      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Nuevo workflow</h2>
        <div className={styles.formRow}>
          <input
            className={styles.input}
            placeholder="Nombre (p.ej. Bienvenida + 3 seguimientos)"
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
          <button className={styles.primaryBtn} onClick={create} disabled={busy}>
            Crear y editar
          </button>
        </div>
      </section>

      <ul className={styles.list}>
        {items.length === 0 && <p className={styles.hint}>Aún no tienes workflows.</p>}
        {items.map((wf) => (
          <li key={wf.id} className={styles.item}>
            <div className={styles.itemInfo}>
              <span className={styles.itemName}>
                {wf.name}{" "}
                {wf.is_active ? (
                  <span className={styles.badgeOn}>activo</span>
                ) : (
                  <span className={styles.badgeOff}>inactivo</span>
                )}
              </span>
              <span className={styles.hint}>
                {TRIGGER_LABEL[wf.trigger]} · {wf.definition?.nodes?.length ?? 0} nodos
              </span>
            </div>
            <div className={styles.actions}>
              <button className={styles.ghostBtn} onClick={() => setEditing(wf)} disabled={busy}>
                Editar
              </button>
              <button className={styles.ghostBtn} onClick={() => toggleActive(wf)} disabled={busy}>
                {wf.is_active ? "Desactivar" : "Activar"}
              </button>
              <button className={styles.dangerBtn} onClick={() => remove(wf)} disabled={busy}>
                Eliminar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
