"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import styles from "./inbox.module.css";

type Stage =
  | "new"
  | "qualifying"
  | "qualified"
  | "not_qualified"
  | "call_scheduled"
  | "won"
  | "lost";

type Analysis = {
  summary: string;
  qualification: "cualificado" | "en_proceso" | "no_cualifica" | "desconocido";
  interest_level: "alto" | "medio" | "bajo";
  sentiment: "positivo" | "neutral" | "negativo";
  suggested_stage: Stage;
  next_step: string;
  key_points: string[];
  objections: string[];
  reasoning: string;
};

type Mode = "setter" | "support" | "ignored" | "unclassified";

type Member = { user_id: string; email: string | null; full_name: string | null; role: string };

type ConvTag = { tag_id: string; name: string; color: string; source: string };

type TagDef = { id: string; name: string; color: string; ai_enabled: boolean };

type Conversation = {
  id: string;
  provider: string | null;
  contact_name: string | null;
  contact_handle: string | null;
  stage: Stage;
  mode?: Mode;
  ai_enabled: boolean;
  blocked?: boolean;
  notes?: string | null;
  assigned_to?: string | null;
  unread_count: number;
  ai_analysis?: Analysis | null;
  ai_analysis_at?: string | null;
  tags?: ConvTag[];
  last_message_at: string | null;
  created_at: string;
};

type Message = {
  id: string;
  role: "contact" | "assistant" | "agent" | "system";
  content: string;
  created_at: string;
};

/** ¿Dos listas de mensajes son equivalentes? (para evitar renders/scroll inútiles) */
function sameMessages(a: Message[], b: Message[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].content !== b[i].content) return false;
  }
  return true;
}

const STAGES: { id: Stage; label: string }[] = [
  { id: "new", label: "Nuevo" },
  { id: "qualifying", label: "Cualificando" },
  { id: "qualified", label: "Cualificado" },
  { id: "call_scheduled", label: "Llamada agendada" },
  { id: "won", label: "Ganado" },
  { id: "not_qualified", label: "No cualifica" },
  { id: "lost", label: "Perdido" },
];

const STAGE_LABEL: Record<Stage, string> = Object.fromEntries(
  STAGES.map((s) => [s.id, s.label]),
) as Record<Stage, string>;

const PROVIDER_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
};

const MODE_LABEL: Record<Mode, string> = {
  setter: "Setter",
  support: "Soporte",
  ignored: "Ignorado",
  unclassified: "Sin clasificar",
};

const MODE_OPTIONS: { id: "setter" | "support" | "ignored"; label: string }[] = [
  { id: "setter", label: "Setter (cualificar)" },
  { id: "support", label: "Soporte" },
  { id: "ignored", label: "Ignorar (no responder)" },
];

const QUAL_LABEL: Record<Analysis["qualification"], string> = {
  cualificado: "Cualificado",
  en_proceso: "En proceso",
  no_cualifica: "No cualifica",
  desconocido: "Desconocido",
};

function initials(name: string | null): string {
  const n = (name ?? "Lead").trim();
  const parts = n.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "L";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });
}

export default function Inbox() {
  const [list, setList] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<Stage | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [tagDefs, setTagDefs] = useState<TagDef[]>([]);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [tagBusy, setTagBusy] = useState(false);
  const [exampleBusy, setExampleBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  // ¿El usuario está pegado al fondo? Solo autoscrolleamos si es así (o al abrir
  // un chat). Evita que el refresco cada 5s le arrastre hacia abajo al leer arriba.
  const atBottomRef = useRef(true);
  const forceBottomRef = useRef(true);

  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distanceFromBottom < 80;
  }, []);

  const loadList = useCallback(async () => {
    try {
      const data = await apiFetch<Conversation[]>("/api/inbox/conversations");
      setList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }, []);

  const loadConv = useCallback(async (id: string) => {
    try {
      const data = await apiFetch<{ conversation: Conversation; messages: Message[] }>(
        `/api/inbox/conversations/${id}`,
      );
      setConv(data.conversation);
      // Solo reemplazamos si de verdad cambió: así el refresco periódico no crea
      // un array nuevo que dispare el autoscroll ni parpadeos innecesarios.
      setMessages((prev) => (sameMessages(prev, data.messages) ? prev : data.messages));
      setAnalysis(data.conversation.ai_analysis ?? null);
      setNotesDraft(data.conversation.notes ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }, []);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 10000);
    return () => clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    apiFetch<Member[]>("/api/inbox/members")
      .then(setMembers)
      .catch(() => setMembers([]));
    apiFetch<TagDef[]>("/api/tags")
      .then(setTagDefs)
      .catch(() => setTagDefs([]));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadConv(selectedId);
    const t = setInterval(() => loadConv(selectedId), 5000);
    return () => clearInterval(t);
  }, [selectedId, loadConv]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Al abrir un chat (forceBottom) siempre bajamos; en refrescos, solo si el
    // usuario ya estaba al fondo. Si está leyendo arriba, no le movemos.
    if (forceBottomRef.current || atBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight });
      forceBottomRef.current = false;
      atBottomRef.current = true;
    }
  }, [messages]);

  function selectConv(id: string) {
    forceBottomRef.current = true;
    atBottomRef.current = true;
    setSelectedId(id);
    setNotesOpen(false);
    setTagMenuOpen(false);
    setError(null);
  }

  async function addTag(tagId: string) {
    if (!conv) return;
    setTagBusy(true);
    try {
      const tags = await apiFetch<ConvTag[]>(`/api/tags/conversations/${conv.id}`, {
        method: "POST",
        body: JSON.stringify({ tagId }),
      });
      setConv({ ...conv, tags });
      loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setTagBusy(false);
    }
  }

  async function removeTag(tagId: string) {
    if (!conv) return;
    setTagBusy(true);
    try {
      const tags = await apiFetch<ConvTag[]>(
        `/api/tags/conversations/${conv.id}/${tagId}`,
        { method: "DELETE" },
      );
      setConv({ ...conv, tags });
      loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setTagBusy(false);
    }
  }

  async function patch(body: Record<string, unknown>) {
    if (!conv) return;
    await apiFetch(`/api/inbox/conversations/${conv.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async function toggleAi() {
    if (!conv) return;
    const next = !conv.ai_enabled;
    setConv({ ...conv, ai_enabled: next });
    await patch({ ai_enabled: next });
    loadList();
  }

  async function changeAssignee(userId: string) {
    if (!conv) return;
    setConv({ ...conv, assigned_to: userId || null });
    await patch({ assigned_to: userId });
  }

  async function changeStage(stage: Stage) {
    if (!conv) return;
    setConv({ ...conv, stage });
    await patch({ stage });
    loadList();
  }

  async function changeMode(mode: "setter" | "support" | "ignored") {
    if (!conv) return;
    setConv({ ...conv, mode });
    await patch({ mode });
    loadList();
  }

  async function toggleBlock() {
    if (!conv) return;
    const next = !conv.blocked;
    setConv({ ...conv, blocked: next, ai_enabled: next ? false : conv.ai_enabled });
    await patch({ blocked: next });
    loadList();
  }

  async function markUnread() {
    if (!conv) return;
    await patch({ unread: true });
    await loadList();
    setSelectedId(null);
    setConv(null);
  }

  async function remove() {
    if (!conv) return;
    if (!confirm("¿Eliminar esta conversación? No se puede deshacer.")) return;
    await apiFetch(`/api/inbox/conversations/${conv.id}`, { method: "DELETE" });
    setSelectedId(null);
    setConv(null);
    setMessages([]);
    loadList();
  }

  async function saveNotes() {
    if (!conv) return;
    setSavingNotes(true);
    try {
      await patch({ notes: notesDraft });
      setConv({ ...conv, notes: notesDraft });
      setNotesOpen(false);
    } finally {
      setSavingNotes(false);
    }
  }

  async function runAnalysis() {
    if (!conv) return;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await apiFetch<Analysis>(
        `/api/inbox/conversations/${conv.id}/analyze`,
        { method: "POST" },
      );
      setAnalysis(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo analizar");
    } finally {
      setAnalyzing(false);
    }
  }

  async function promoteExample() {
    if (!conv) return;
    if (
      !confirm(
        "¿Añadir esta conversación a los ejemplos del setter? El bot aprenderá de ella.",
      )
    )
      return;
    setExampleBusy(true);
    setError(null);
    setSyncInfo(null);
    try {
      const res = await apiFetch<{ turns: number; truncated?: boolean }>(
        `/api/inbox/conversations/${conv.id}/promote-example`,
        { method: "POST" },
      );
      setSyncInfo(
        res.truncated
          ? "Ejemplo añadido (se recortó por límite de tamaño)."
          : `Ejemplo añadido (${res.turns} mensajes).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo añadir el ejemplo");
    } finally {
      setExampleBusy(false);
    }
  }

  async function downloadTranscript() {
    if (!conv) return;
    setExampleBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ filename: string; content: string }>(
        `/api/inbox/conversations/${conv.id}/export`,
      );
      const blob = new Blob([res.content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename || "conversacion.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo descargar");
    } finally {
      setExampleBusy(false);
    }
  }

  async function send() {
    if (!conv || !draft.trim()) return;
    setSending(true);
    setError(null);
    const content = draft.trim();
    setDraft("");
    try {
      await apiFetch(`/api/inbox/conversations/${conv.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      await loadConv(conv.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al enviar");
    } finally {
      setSending(false);
    }
  }

  async function sync() {
    setSyncing(true);
    setSyncInfo(null);
    setError(null);
    try {
      const res = await apiFetch<{ channels: number; chats: number }>(
        "/api/inbox/sync",
        { method: "POST" },
      );
      setSyncInfo(`${res.chats} chats sincronizados`);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al sincronizar");
    } finally {
      setSyncing(false);
    }
  }

  const filtered = filter === "all" ? list : list.filter((c) => c.stage === filter);

  return (
    <div className={styles.inbox}>
      {/* ---------- Lista ---------- */}
      <div className={styles.listPane}>
        <div className={styles.listHeader}>
          <span className={styles.listTitle}>Chats</span>
          <button className={styles.syncBtn} onClick={sync} disabled={syncing}>
            {syncing ? "Sincronizando…" : "Sincronizar"}
          </button>
        </div>
        {syncInfo && <div className={styles.syncInfo}>{syncInfo}</div>}
        <div className={styles.filters}>
          <button
            className={`${styles.filter} ${filter === "all" ? styles.filterActive : ""}`}
            onClick={() => setFilter("all")}
          >
            Todos
          </button>
          {STAGES.map((s) => (
            <button
              key={s.id}
              className={`${styles.filter} ${filter === s.id ? styles.filterActive : ""}`}
              onClick={() => setFilter(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className={styles.convList}>
          {filtered.length === 0 ? (
            <p className={styles.empty}>
              No hay conversaciones todavía. Cuando un lead escriba a un canal conectado,
              aparecerá aquí.
            </p>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                className={`${styles.convItem} ${selectedId === c.id ? styles.convActive : ""}`}
                onClick={() => selectConv(c.id)}
              >
                <div className={styles.avatar}>{initials(c.contact_name)}</div>
                <div className={styles.convBody}>
                  <div className={styles.convTop}>
                    <span className={styles.convName}>{c.contact_name ?? "Lead"}</span>
                    {c.unread_count > 0 && <span className={styles.badge}>{c.unread_count}</span>}
                  </div>
                  <div className={styles.convMeta}>
                    <span className={styles.provider}>
                      {PROVIDER_LABEL[c.provider ?? ""] ?? c.provider}
                    </span>
                    {c.mode && c.mode !== "unclassified" && (
                      <span className={`${styles.modeTag} ${styles["mode_" + c.mode]}`}>
                        {MODE_LABEL[c.mode]}
                      </span>
                    )}
                    {c.blocked ? (
                      <span className={styles.blockedTag}>Bloqueado</span>
                    ) : (
                      !c.ai_enabled && <span className={styles.paused}>IA en pausa</span>
                    )}
                  </div>
                  {c.tags && c.tags.length > 0 && (
                    <div className={styles.convTags}>
                      {c.tags.slice(0, 4).map((t) => (
                        <span
                          key={t.tag_id}
                          className={styles.convTagChip}
                          style={{ borderColor: t.color, color: t.color }}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ---------- Chat ---------- */}
      <div className={styles.chatPane}>
        {!conv ? (
          <div className={styles.placeholder}>Selecciona una conversación</div>
        ) : (
          <>
            <div className={styles.chatHeader}>
              <div className={styles.chatPerson}>
                <div className={styles.avatarLg}>{initials(conv.contact_name)}</div>
                <div>
                  <div className={styles.chatNameRow}>
                    <span className={styles.chatName}>{conv.contact_name ?? "Lead"}</span>
                    <span className={styles.channelChip}>
                      {PROVIDER_LABEL[conv.provider ?? ""] ?? conv.provider}
                    </span>
                  </div>
                  <span className={styles.chatHandle}>{conv.contact_handle ?? ""}</span>
                </div>
              </div>
              <button
                className={`${styles.aiToggle} ${conv.ai_enabled ? styles.aiOn : styles.aiOff}`}
                onClick={toggleAi}
              >
                {conv.ai_enabled ? "IA activa" : "IA en pausa"}
              </button>
            </div>

            {/* Barra de acciones (estilo SkaleX) */}
            <div className={styles.toolbar}>
              <select
                className={styles.moveSelect}
                value={conv.mode && conv.mode !== "unclassified" ? conv.mode : ""}
                onChange={(e) =>
                  changeMode(e.target.value as "setter" | "support" | "ignored")
                }
                title="Modo del bot en esta conversación"
              >
                {(!conv.mode || conv.mode === "unclassified") && (
                  <option value="" disabled>
                    Modo: sin clasificar
                  </option>
                )}
                {MODE_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                className={styles.moveSelect}
                value={conv.stage}
                onChange={(e) => changeStage(e.target.value as Stage)}
                title="Mover de fase"
              >
                {STAGES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                className={styles.moveSelect}
                value={conv.assigned_to ?? ""}
                onChange={(e) => changeAssignee(e.target.value)}
                title="Asignar a un miembro del equipo"
              >
                <option value="">Sin asignar</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.full_name || m.email || m.user_id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <div className={styles.tagWrap}>
                <button
                  className={`${styles.toolBtn} ${tagMenuOpen ? styles.toolBtnActive : ""}`}
                  onClick={() => setTagMenuOpen((v) => !v)}
                >
                  Etiquetas{conv.tags && conv.tags.length > 0 ? ` (${conv.tags.length})` : ""}
                </button>
                {tagMenuOpen && (
                  <div className={styles.tagMenu}>
                    {tagDefs.length === 0 && (
                      <div className={styles.tagMenuEmpty}>
                        No hay etiquetas. Créalas en “Etiquetas”.
                      </div>
                    )}
                    {tagDefs.map((def) => {
                      const active = (conv.tags ?? []).some((t) => t.tag_id === def.id);
                      return (
                        <button
                          key={def.id}
                          className={styles.tagMenuItem}
                          disabled={tagBusy}
                          onClick={() => (active ? removeTag(def.id) : addTag(def.id))}
                        >
                          <span className={styles.tagDot} style={{ background: def.color }} />
                          <span className={styles.tagMenuName}>{def.name}</span>
                          {active && <span className={styles.tagCheck}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button className={styles.toolBtn} onClick={() => setNotesOpen((v) => !v)}>
                Nota{conv.notes ? " ●" : ""}
              </button>
              <button className={styles.toolBtn} onClick={markUnread}>
                No leído
              </button>
              <button
                className={`${styles.toolBtn} ${conv.blocked ? styles.toolBtnActive : ""}`}
                onClick={toggleBlock}
              >
                {conv.blocked ? "Desbloquear" : "Bloquear"}
              </button>
              <button
                className={styles.toolBtn}
                onClick={promoteExample}
                disabled={exampleBusy}
                title="Añadir esta conversación a los ejemplos del setter"
              >
                Usar como ejemplo
              </button>
              <button
                className={styles.toolBtn}
                onClick={downloadTranscript}
                disabled={exampleBusy}
                title="Descargar la conversación en Markdown"
              >
                Descargar
              </button>
              <button className={`${styles.toolBtn} ${styles.toolDanger}`} onClick={remove}>
                Eliminar
              </button>
              <button className={styles.toolBtn} disabled title="Próximamente">
                Programar mensaje
              </button>
            </div>

            {conv.tags && conv.tags.length > 0 && (
              <div className={styles.tagPills}>
                {conv.tags.map((t) => (
                  <span
                    key={t.tag_id}
                    className={styles.tagPill}
                    style={{ borderColor: t.color, color: t.color }}
                    title={t.source === "ai" ? "Etiqueta puesta por la IA" : "Etiqueta manual"}
                  >
                    <span className={styles.tagDot} style={{ background: t.color }} />
                    {t.name}
                    <button
                      className={styles.tagPillX}
                      onClick={() => removeTag(t.tag_id)}
                      disabled={tagBusy}
                      title="Quitar (la IA no la volverá a poner)"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {notesOpen && (
              <div className={styles.notesBox}>
                <textarea
                  className={styles.notesArea}
                  placeholder="Notas internas sobre este lead…"
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={3}
                />
                <div className={styles.notesActions}>
                  <button className={styles.notesCancel} onClick={() => setNotesOpen(false)}>
                    Cancelar
                  </button>
                  <button className={styles.notesSave} onClick={saveNotes} disabled={savingNotes}>
                    {savingNotes ? "Guardando…" : "Guardar nota"}
                  </button>
                </div>
              </div>
            )}

            <div className={styles.messages} ref={scrollRef} onScroll={onMessagesScroll}>
              {messages.map((m, i) => {
                const fromUs = m.role !== "contact";
                const prev = messages[i - 1];
                const showDay =
                  !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at);
                const tag =
                  m.role === "assistant"
                    ? "Respuesta de IA"
                    : m.role === "agent"
                    ? "Manual"
                    : null;
                return (
                  <Fragment key={m.id}>
                    {showDay && (
                      <div className={styles.dateSep}>
                        <span>{dayLabel(m.created_at)}</span>
                      </div>
                    )}
                    <div
                      className={`${styles.bubble} ${
                        fromUs ? styles.fromUs : styles.fromContact
                      }`}
                    >
                      {tag && (
                        <span
                          className={`${styles.msgTag} ${
                            m.role === "agent" ? styles.tagManual : styles.tagAi
                          }`}
                        >
                          {tag}
                        </span>
                      )}
                      <span className={styles.msgText}>{m.content}</span>
                      <span className={styles.msgMeta}>
                        {timeLabel(m.created_at)}
                        {fromUs && <span className={styles.checks}>✓✓</span>}
                      </span>
                    </div>
                  </Fragment>
                );
              })}
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.composer}>
              <input
                className={styles.input}
                placeholder="Escribe un mensaje (pausará la IA)…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                disabled={sending}
              />
              <button className={styles.sendBtn} onClick={send} disabled={sending || !draft.trim()}>
                {sending ? "…" : "Enviar"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ---------- Panel de control ---------- */}
      {conv && (
        <div className={styles.panel}>
          <div className={styles.panelSection}>
            <div className={styles.panelTitle}>Info del contacto</div>
            <div className={styles.infoRow}>
              <span>Nombre</span>
              <strong>{conv.contact_name ?? "Lead"}</strong>
            </div>
            <div className={styles.infoRow}>
              <span>Contacto</span>
              <strong>{conv.contact_handle ?? "—"}</strong>
            </div>
            <div className={styles.infoRow}>
              <span>Canal</span>
              <strong>{PROVIDER_LABEL[conv.provider ?? ""] ?? conv.provider ?? "—"}</strong>
            </div>
            <div className={styles.infoRow}>
              <span>Creado</span>
              <strong>{formatDate(conv.created_at)}</strong>
            </div>
          </div>

          <div className={styles.panelSection}>
            <div className={styles.panelTitle}>Fase del funnel</div>
            <div className={styles.stageBadge}>{STAGE_LABEL[conv.stage]}</div>
            {analysis?.next_step && (
              <p className={styles.nextStep}>
                <span>Siguiente paso</span>
                {analysis.next_step}
              </p>
            )}
          </div>

          <div className={styles.panelSection}>
            <div className={styles.panelTitleRow}>
              <span className={styles.panelTitle}>Análisis IA</span>
              <button
                className={styles.analyzeBtn}
                onClick={runAnalysis}
                disabled={analyzing}
              >
                {analyzing ? "Analizando…" : analysis ? "Re-analizar" : "Analizar"}
              </button>
            </div>

            {!analysis ? (
              <p className={styles.analyzeHint}>
                Genera un análisis completo de la conversación: cualificación, interés,
                objeciones y próximo paso.
              </p>
            ) : (
              <div className={styles.analysis}>
                <div className={styles.tags}>
                  <span className={`${styles.qual} ${styles["q_" + analysis.qualification]}`}>
                    {QUAL_LABEL[analysis.qualification]}
                  </span>
                  <span className={styles.metaTag}>Interés: {analysis.interest_level}</span>
                  <span className={styles.metaTag}>{analysis.sentiment}</span>
                </div>

                <p className={styles.summary}>{analysis.summary}</p>

                {analysis.key_points.length > 0 && (
                  <div className={styles.block}>
                    <span className={styles.blockTitle}>Puntos clave</span>
                    <ul>
                      {analysis.key_points.map((k, i) => (
                        <li key={i}>{k}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {analysis.objections.length > 0 && (
                  <div className={styles.block}>
                    <span className={styles.blockTitle}>Objeciones</span>
                    <ul>
                      {analysis.objections.map((k, i) => (
                        <li key={i}>{k}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {analysis.reasoning && (
                  <div className={styles.block}>
                    <span className={styles.blockTitle}>Razonamiento</span>
                    <p className={styles.reasoning}>{analysis.reasoning}</p>
                  </div>
                )}

                {analysis.suggested_stage && analysis.suggested_stage !== conv.stage && (
                  <button
                    className={styles.applyStage}
                    onClick={() => changeStage(analysis.suggested_stage)}
                  >
                    Mover a: {STAGE_LABEL[analysis.suggested_stage]}
                  </button>
                )}

                {conv.ai_analysis_at && (
                  <span className={styles.analyzedAt}>
                    Analizado el {formatDate(conv.ai_analysis_at)}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className={styles.panelSection}>
            <div className={styles.panelTitle}>Control IA</div>
            <button
              className={`${styles.controlBtn} ${conv.ai_enabled ? styles.aiOn : styles.aiOff}`}
              onClick={toggleAi}
            >
              {conv.ai_enabled ? "IA activa · pausar" : "IA en pausa · activar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
