"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import styles from "./channels.module.css";

export type Channel = {
  id: string;
  provider: "whatsapp" | "instagram" | "messenger" | "linkedin" | "telegram";
  status: "pending" | "connected" | "error" | "disconnected";
  display_name: string | null;
  last_error: string | null;
  created_at: string;
  connected_at: string | null;
};

type ConnectableProvider = "whatsapp" | "instagram" | "messenger";

const PROVIDERS: { id: ConnectableProvider; label: string; hint: string }[] = [
  { id: "whatsapp", label: "WhatsApp", hint: "Escanea un QR para vincular tu número" },
  { id: "instagram", label: "Instagram", hint: "Conecta tu cuenta de Instagram DMs" },
  { id: "messenger", label: "Messenger", hint: "Conecta tu página de Facebook" },
];

const STATUS_LABEL: Record<Channel["status"], string> = {
  pending: "Pendiente",
  connected: "Conectado",
  error: "Error",
  disconnected: "Desconectado",
};

const PROVIDER_LABEL: Record<Channel["provider"], string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  linkedin: "LinkedIn",
  telegram: "Telegram",
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID ?? "";
const META_CONFIG_ID = process.env.NEXT_PUBLIC_META_CONFIG_ID ?? "";

type FacebookSdk = {
  init: (opts: Record<string, unknown>) => void;
  login: (
    cb: (resp: { authResponse?: { code?: string } }) => void,
    opts: Record<string, unknown>,
  ) => void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

export default function ChannelsManager({
  initialChannels,
  isAdmin,
}: {
  initialChannels: Channel[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const justConnected = searchParams.get("connected") === "1";
  const justFailed = searchParams.get("error") === "1";

  const authHeaders = useCallback(async (): Promise<HeadersInit> => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
    };
  }, []);

  const reconcileSilently = useCallback(async () => {
    try {
      await fetch(`${API_URL}/api/channels/reconcile`, {
        method: "POST",
        headers: await authHeaders(),
      });
      router.refresh();
    } catch {
      // Si falla, el usuario siempre puede pulsar "Actualizar estado".
    }
  }, [authHeaders, router]);

  // Al volver del asistente de Unipile (?connected=1), reconciliamos una vez
  // automáticamente para que el canal aparezca como conectado sin intervención.
  const didAutoReconcile = useRef(false);
  useEffect(() => {
    if (justConnected && !didAutoReconcile.current) {
      didAutoReconcile.current = true;
      void reconcileSilently();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justConnected]);

  async function connect(provider: ConnectableProvider) {
    setBusy(provider);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/channels/connect`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error((await res.json())?.message ?? "Error al conectar");
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al conectar");
      setBusy(null);
    }
  }

  // --- Embedded Signup (WhatsApp Cloud API oficial) ---
  const cloudConfigured = Boolean(META_APP_ID && META_CONFIG_ID);
  const sessionInfo = useRef<{ phoneNumberId?: string; wabaId?: string }>({});

  useEffect(() => {
    if (!cloudConfigured) return;

    // Orígenes EXACTOS de Meta (endsWith permitiría "evil-facebook.com").
    const ALLOWED_FB_ORIGINS = new Set([
      "https://www.facebook.com",
      "https://web.facebook.com",
      "https://business.facebook.com",
    ]);

    // Captura phone_number_id + waba_id que Meta envía por postMessage.
    const onMessage = (event: MessageEvent) => {
      if (!ALLOWED_FB_ORIGINS.has(event.origin)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.event === "FINISH") {
          sessionInfo.current = {
            phoneNumberId: data.data?.phone_number_id,
            wabaId: data.data?.waba_id,
          };
        }
      } catch {
        // payloads no-JSON de facebook: se ignoran
      }
    };
    window.addEventListener("message", onMessage);

    if (!document.getElementById("facebook-jssdk")) {
      window.fbAsyncInit = () => {
        window.FB?.init({ appId: META_APP_ID, autoLogAppEvents: true, xfbml: true, version: "v23.0" });
      };
      const js = document.createElement("script");
      js.id = "facebook-jssdk";
      js.src = "https://connect.facebook.net/en_US/sdk.js";
      js.async = true;
      js.defer = true;
      document.body.appendChild(js);
    }

    return () => window.removeEventListener("message", onMessage);
  }, [cloudConfigured]);

  async function connectCloud() {
    if (!window.FB) {
      setError("El SDK de Meta aún se está cargando, inténtalo en unos segundos.");
      return;
    }
    setBusy("cloud");
    setError(null);
    sessionInfo.current = {};
    window.FB.login(
      async (resp) => {
        const code = resp.authResponse?.code;
        if (!code) {
          setError("No se completó el alta de WhatsApp.");
          setBusy(null);
          return;
        }
        try {
          const res = await fetch(`${API_URL}/api/channels/cloud/connect`, {
            method: "POST",
            headers: await authHeaders(),
            body: JSON.stringify({
              code,
              phoneNumberId: sessionInfo.current.phoneNumberId,
              wabaId: sessionInfo.current.wabaId,
            }),
          });
          if (!res.ok) throw new Error((await res.json())?.message ?? "Error al conectar");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Error al conectar");
        } finally {
          setBusy(null);
        }
      },
      {
        config_id: META_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      },
    );
  }

  async function reconcile() {
    setBusy("reconcile");
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/channels/reconcile`, {
        method: "POST",
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json())?.message ?? "Error al actualizar");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al actualizar");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/channels/${id}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json())?.message ?? "Error al desconectar");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al desconectar");
    } finally {
      setBusy(null);
    }
  }

  const active = initialChannels.filter((c) => c.status !== "disconnected");

  return (
    <div className={styles.wrap}>
      {justConnected && (
        <div className={`${styles.banner} ${styles.bannerOk}`}>
          Canal conectado. Si no aparece abajo, pulsa “Actualizar estado”.
        </div>
      )}
      {justFailed && (
        <div className={`${styles.banner} ${styles.bannerErr}`}>
          La conexión no se completó. Inténtalo de nuevo.
        </div>
      )}
      {error && <div className={`${styles.banner} ${styles.bannerErr}`}>{error}</div>}

      {!isAdmin && (
        <div className={styles.banner}>
          Solo un administrador puede conectar o desconectar canales.
        </div>
      )}

      <div className={styles.providerGrid}>
        {PROVIDERS.map((p) => (
          <article key={p.id} className={styles.providerCard}>
            <div className={styles.providerHead}>
              <span className={styles.providerName}>{p.label}</span>
            </div>
            <p className={styles.providerHint}>{p.hint}</p>
            <button
              className={styles.connectBtn}
              disabled={!isAdmin || busy !== null}
              onClick={() => connect(p.id)}
            >
              {busy === p.id ? "Abriendo…" : "Conectar"}
            </button>
          </article>
        ))}
      </div>

      <div className={styles.providerGrid}>
        <article className={styles.providerCard}>
          <div className={styles.providerHead}>
            <span className={styles.providerName}>WhatsApp oficial (Cloud API)</span>
          </div>
          <p className={styles.providerHint}>
            Conecta tu número con la API oficial de Meta (recomendado para anuncios
            click-to-WhatsApp y atribución de conversiones).
          </p>
          {cloudConfigured ? (
            <button
              className={styles.connectBtn}
              disabled={!isAdmin || busy !== null}
              onClick={connectCloud}
            >
              {busy === "cloud" ? "Abriendo…" : "Conectar con Meta"}
            </button>
          ) : (
            <p className={styles.providerHint}>
              Configura <code>NEXT_PUBLIC_META_APP_ID</code> y{" "}
              <code>NEXT_PUBLIC_META_CONFIG_ID</code> para habilitar el alta.
            </p>
          )}
        </article>
      </div>

      <div className={styles.listHead}>
        <h2 className={styles.listTitle}>Canales conectados</h2>
        <button
          className={styles.ghostBtn}
          disabled={busy !== null}
          onClick={reconcile}
        >
          {busy === "reconcile" ? "Actualizando…" : "Actualizar estado"}
        </button>
      </div>

      {active.length === 0 ? (
        <p className={styles.empty}>Aún no hay canales conectados.</p>
      ) : (
        <ul className={styles.channelList}>
          {active.map((c) => (
            <li key={c.id} className={styles.channelRow}>
              <div className={styles.channelInfo}>
                <span className={styles.channelProvider}>{PROVIDER_LABEL[c.provider]}</span>
                <span className={styles.channelName}>
                  {c.display_name ?? "Sin nombre"}
                </span>
                {c.status === "error" && c.last_error && (
                  <span className={styles.channelError}>{c.last_error}</span>
                )}
              </div>
              <div className={styles.channelActions}>
                <span className={`${styles.status} ${styles[`status_${c.status}`]}`}>
                  {STATUS_LABEL[c.status]}
                </span>
                {isAdmin && (
                  <button
                    className={styles.disconnectBtn}
                    disabled={busy !== null}
                    onClick={() => disconnect(c.id)}
                  >
                    {busy === c.id ? "…" : "Desconectar"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
