"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import styles from "./crm.module.css";

type LeadRow = {
  id: string;
  conversation_id: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  provider: string | null;
  source: string | null;
  source_detail: string | null;
  campaign: string | null;
  status: string;
  created_at: string;
};

type LeadDetail = LeadRow & {
  external_id: string | null;
  consent_optin: boolean;
  first_message: string | null;
  fields: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
  notes: string | null;
  updated_at: string;
};

type ConversationSummary = {
  id: string;
  provider: string;
  contact_name: string | null;
  contact_handle: string | null;
  stage: string;
  mode: string;
  ai_enabled: boolean;
  last_message_at: string | null;
} | null;

type Stats = {
  total: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
};

const STATUSES: { value: string; label: string }[] = [
  { value: "new", label: "Nuevo" },
  { value: "qualifying", label: "Cualificando" },
  { value: "qualified", label: "Cualificado" },
  { value: "not_qualified", label: "No cualifica" },
  { value: "call_scheduled", label: "Llamada agendada" },
  { value: "won", label: "Ganado" },
  { value: "lost", label: "Perdido" },
];

const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  STATUSES.map((s) => [s.value, s.label]),
);

const SOURCE_LABEL: Record<string, string> = {
  ghl: "GoHighLevel",
  manychat: "ManyChat",
  meta_lead: "Meta Lead Ads",
  ig_comment: "Comentario IG",
  ig_dm: "DM Instagram",
  ctwa: "Click-to-WhatsApp",
  webhook: "Webhook",
  manual: "Manual",
  organic: "Orgánico",
};

function sourceLabel(s: string | null): string {
  if (!s) return "—";
  return SOURCE_LABEL[s] ?? s;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Crm() {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (source) params.set("source", source);
      if (search.trim()) params.set("search", search.trim());
      const qs = params.toString();
      const [rows, st] = await Promise.all([
        apiFetch<LeadRow[]>(`/api/crm/leads${qs ? `?${qs}` : ""}`),
        apiFetch<Stats>("/api/crm/leads/stats").catch(() => null),
      ]);
      setLeads(Array.isArray(rows) ? rows : []);
      if (st) setStats(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      setLoading(false);
    }
  }, [status, source, search]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const sources = stats ? Object.keys(stats.bySource) : [];

  return (
    <div className={styles.wrap}>
      {error && <div className={styles.error}>{error}</div>}

      {stats && (
        <div className={styles.statsRow}>
          <StatCard label="Total leads" value={stats.total} accent onClick={() => setStatus("")} />
          <StatCard
            label="Nuevos"
            value={stats.byStatus.new ?? 0}
            onClick={() => setStatus("new")}
          />
          <StatCard
            label="Cualificados"
            value={stats.byStatus.qualified ?? 0}
            onClick={() => setStatus("qualified")}
          />
          <StatCard
            label="Llamadas"
            value={stats.byStatus.call_scheduled ?? 0}
            onClick={() => setStatus("call_scheduled")}
          />
          <StatCard
            label="Ganados"
            value={stats.byStatus.won ?? 0}
            onClick={() => setStatus("won")}
          />
        </div>
      )}

      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          placeholder="Buscar por nombre, teléfono o email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className={styles.select} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos los estados</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select className={styles.select} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Todas las fuentes</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
        <button className={styles.ghostBtn} onClick={load}>
          Actualizar
        </button>
      </div>

      {loading ? (
        <p className={styles.muted}>Cargando…</p>
      ) : leads.length === 0 ? (
        <div className={styles.empty}>
          <p>Aún no hay leads.</p>
          <p className={styles.muted}>
            En cuanto entre uno por GoHighLevel, ManyChat o tu formulario, aparecerá aquí
            automáticamente.
          </p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Contacto</th>
                <th>Fuente</th>
                <th>Campaña</th>
                <th>Estado</th>
                <th>Fecha de creación</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} onClick={() => setSelected(l.id)} className={styles.row}>
                  <td className={styles.nameCell}>{l.name || "Lead"}</td>
                  <td className={styles.muted}>{l.phone || l.email || "—"}</td>
                  <td>
                    <span className={styles.sourceTag}>{sourceLabel(l.source)}</span>
                  </td>
                  <td className={styles.muted}>{l.campaign || l.source_detail || "—"}</td>
                  <td>
                    <span className={`${styles.statusTag} ${styles[`st_${l.status}`] ?? ""}`}>
                      {STATUS_LABEL[l.status] ?? l.status}
                    </span>
                  </td>
                  <td className={styles.muted}>{fmtDate(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <LeadDrawer
          id={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  accent?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={`${styles.statCard} ${accent ? styles.statAccent : ""}`} onClick={onClick}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </button>
  );
}

function LeadDrawer({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<{ lead: LeadDetail; conversation: ConversationSummary } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    apiFetch<{ lead: LeadDetail; conversation: ConversationSummary }>(`/api/crm/leads/${id}`)
      .then((d) => {
        setData(d);
        setNotes(d.lead.notes ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error al cargar"));
  }, [id]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const updated = await apiFetch<LeadDetail>(`/api/crm/leads/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setData((prev) => (prev ? { ...prev, lead: { ...prev.lead, ...updated } } : prev));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  const lead = data?.lead;
  const conv = data?.conversation;
  const rawEntries = lead?.raw ? Object.entries(lead.raw) : [];

  return (
    <div className={styles.overlay} onClick={onClose}>
      <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHead}>
          <div>
            <h2 className={styles.drawerTitle}>{lead?.name || "Lead"}</h2>
            {lead && <span className={styles.sourceTag}>{sourceLabel(lead.source)}</span>}
          </div>
          <button className={styles.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className={styles.error}>{error}</div>}
        {!lead ? (
          <p className={styles.muted}>Cargando…</p>
        ) : (
          <div className={styles.drawerBody}>
            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Contacto</h3>
              <Field label="Nombre" value={lead.name} />
              <Field label="Teléfono" value={lead.phone} />
              <Field label="Email" value={lead.email} />
              <Field label="Canal" value={lead.provider} />
            </section>

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Origen</h3>
              <Field label="Fuente" value={sourceLabel(lead.source)} />
              <Field label="Detalle" value={lead.source_detail} />
              <Field label="Campaña" value={lead.campaign} />
              <Field label="ID externo" value={lead.external_id} />
              <Field label="Opt-in" value={lead.consent_optin ? "Sí" : "No"} />
              <Field label="Fecha de creación" value={fmtDate(lead.created_at)} />
            </section>

            {lead.first_message && (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>Primer mensaje</h3>
                <p className={styles.quote}>{lead.first_message}</p>
              </section>
            )}

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Estado en el embudo</h3>
              <select
                className={styles.select}
                value={lead.status}
                onChange={(e) => patch({ status: e.target.value })}
                disabled={saving}
              >
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </section>

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Notas</h3>
              <textarea
                className={styles.textarea}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anotaciones internas sobre este lead…"
                rows={3}
              />
              <button
                className={styles.saveBtn}
                onClick={() => patch({ notes })}
                disabled={saving || notes === (lead.notes ?? "")}
              >
                {saving ? "Guardando…" : "Guardar nota"}
              </button>
            </section>

            {conv && (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>Conversación</h3>
                <Field label="Etapa" value={STATUS_LABEL[conv.stage] ?? conv.stage} />
                <Field label="Modo" value={conv.mode} />
                <Field label="IA activa" value={conv.ai_enabled ? "Sí" : "No"} />
                <Field label="Último mensaje" value={fmtDate(conv.last_message_at)} />
                <Link href="/dashboard/inbox" className={styles.linkBtn}>
                  Abrir en Chats →
                </Link>
              </section>
            )}

            {rawEntries.length > 0 && (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>Todos los datos recibidos</h3>
                <div className={styles.rawGrid}>
                  {rawEntries.map(([k, v]) => (
                    <div key={k} className={styles.rawItem}>
                      <span className={styles.rawKey}>{k}</span>
                      <span className={styles.rawVal}>{formatValue(v)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value || "—"}</span>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
