"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import styles from "./integrations.module.css";

type Urls = {
  lead_intake: string;
  ghl_lead: string;
  ghl_appointment: string;
  manychat_dynamic: string;
};

type Integration = {
  intake_token: string;
  manychat_api_key: string | null;
  default_channel_id: string | null;
  proactive_enabled: boolean;
  ghl_webhook_url: string | null;
  urls: Urls;
};

type Channel = {
  id: string;
  provider: string;
  status?: string;
  display_name?: string | null;
};

export default function Integrations() {
  const [data, setData] = useState<Integration | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [manychatKey, setManychatKey] = useState("");
  const [ghlWebhookUrl, setGhlWebhookUrl] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch<Integration>("/api/integrations"),
      apiFetch<Channel[]>("/api/channels").catch(() => [] as Channel[]),
    ])
      .then(([integ, chs]) => {
        setData(integ);
        setManychatKey(integ.manychat_api_key ?? "");
        setGhlWebhookUrl(integ.ghl_webhook_url ?? "");
        setChannels(Array.isArray(chs) ? chs : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error al cargar"))
      .finally(() => setLoading(false));
  }, []);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<Integration>("/api/integrations", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setData(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (!confirm("¿Generar un token nuevo? Las URLs antiguas dejarán de funcionar.")) return;
    setSaving(true);
    try {
      const updated = await apiFetch<Integration>("/api/integrations/rotate-token", {
        method: "POST",
      });
      setData(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al rotar el token");
    } finally {
      setSaving(false);
    }
  }

  function copy(value: string, label: string) {
    navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  if (loading) return <p className={styles.muted}>Cargando…</p>;
  if (!data) return <p className={styles.error}>{error ?? "No se pudo cargar"}</p>;

  const waChannels = channels.filter((c) => c.provider === "whatsapp");

  return (
    <div className={styles.wrap}>
      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Webhooks de entrada</h2>
        <p className={styles.muted}>
          Pega estas URLs en cada plataforma. Llevan tu token secreto; trátalas como una contraseña.
        </p>

        <UrlRow
          label="① Registrar leads en el CRM (GoHighLevel, Zapier, Make, tu formulario)"
          hint="ESTA es la URL para que un lead ENTRE al CRM. Un único webhook para todos. POST con JSON. Detecta automáticamente GoHighLevel (first_name, customData, contact_id) y marca la fuente. En GHL: Workflow (trigger de nuevo lead) → acción “Webhook (Outbound)” (POST) a esta URL."
          url={data.urls.lead_intake}
          copied={copied === "generic"}
          onCopy={() => copy(data.urls.lead_intake, "generic")}
        />
        <UrlRow
          label="② GoHighLevel · Cita agendada/cancelada (NO usar para registrar leads)"
          hint="SOLO para eventos de cita. Workflow → trigger “Appointment (Booked/Cancelled)” → acción “Webhook (Outbound)” (POST). Incluye el campo setter_id para enlazarlo. Al recibirlo, se pausan los seguimientos. Si registras leads aquí por error, NO aparecerán en el CRM."
          url={data.urls.ghl_appointment}
          copied={copied === "ghl_appt"}
          onCopy={() => copy(data.urls.ghl_appointment, "ghl_appt")}
        />
        <UrlRow
          label="ManyChat (Instagram)"
          hint="Flow → Dynamic Block / External Request (POST). El bot responde por IG."
          url={data.urls.manychat_dynamic}
          copied={copied === "mc"}
          onCopy={() => copy(data.urls.manychat_dynamic, "mc")}
        />

        <div className={styles.tokenRow}>
          <span className={styles.muted}>
            Token: <code className={styles.code}>{data.intake_token}</code>
          </span>
          <button className={styles.ghostBtn} onClick={rotate} disabled={saving}>
            Generar token nuevo
          </button>
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Primer mensaje proactivo (WhatsApp)</h2>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={data.proactive_enabled}
            onChange={(e) => patch({ proactive_enabled: e.target.checked })}
            disabled={saving}
          />
          <span>
            <strong>Contactar leads automáticamente</strong> — cuando entra un lead con teléfono,
            el bot envía el primer mensaje (con la plantilla de Mi Setter → Soporte) de forma
            espaciada y respetando el horario activo.
          </span>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Canal de WhatsApp para el primer contacto</span>
          <select
            className={styles.input}
            value={data.default_channel_id ?? ""}
            onChange={(e) => patch({ default_channel_id: e.target.value })}
            disabled={saving}
          >
            <option value="">Automático (primer WhatsApp conectado)</option>
            {waChannels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name ?? c.id} {c.status ? `· ${c.status}` : ""}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.muted}>
          La plantilla del primer mensaje se configura en <strong>Mi Setter → Soporte</strong>. Usa
          variables como {"{nombre}"}.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>GoHighLevel · Respuesta de salida</h2>
        <p className={styles.muted}>
          Cuando entra un lead, el setter devuelve a GHL un webhook con el{" "}
          <code className={styles.code}>setter_id</code> (id único de la conversación) y el{" "}
          <code className={styles.code}>ghl_contact_id</code>. Crea en GHL un Workflow con trigger{" "}
          <strong>“Inbound Webhook”</strong>, pega aquí su URL, y añade una acción{" "}
          <strong>“Update Contact Field”</strong> guardando <code className={styles.code}>setter_id</code>{" "}
          en un campo personalizado del contacto.
        </p>
        <label className={styles.field}>
          <span className={styles.label}>URL del Inbound Webhook de GHL</span>
          <input
            className={styles.input}
            type="url"
            value={ghlWebhookUrl}
            onChange={(e) => setGhlWebhookUrl(e.target.value)}
            placeholder="https://services.leadconnectorhq.com/hooks/…"
          />
        </label>
        <button
          className={styles.saveBtn}
          onClick={() => patch({ ghl_webhook_url: ghlWebhookUrl })}
          disabled={saving}
        >
          {saving ? "Guardando…" : "Guardar URL de salida"}
        </button>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>ManyChat</h2>
        <label className={styles.field}>
          <span className={styles.label}>
            API key de ManyChat <span className={styles.hint}>— opcional, para enviar por IG fuera del flujo</span>
          </span>
          <input
            className={styles.input}
            type="password"
            value={manychatKey}
            onChange={(e) => setManychatKey(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        <button
          className={styles.saveBtn}
          onClick={() => patch({ manychat_api_key: manychatKey })}
          disabled={saving}
        >
          {saving ? "Guardando…" : "Guardar API key"}
        </button>
      </section>
    </div>
  );
}

function UrlRow({
  label,
  hint,
  url,
  copied,
  onCopy,
}: {
  label: string;
  hint: string;
  url: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className={styles.urlRow}>
      <div className={styles.urlHead}>
        <span className={styles.urlLabel}>{label}</span>
        <button className={styles.copyBtn} onClick={onCopy}>
          {copied ? "Copiado ✓" : "Copiar"}
        </button>
      </div>
      <code className={styles.url}>{url}</code>
      <span className={styles.hint}>{hint}</span>
    </div>
  );
}
