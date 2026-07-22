import { BadRequestException } from '@nestjs/common';

/**
 * Validación anti-SSRF para URLs de webhooks de SALIDA que configura el cliente
 * (p.ej. `ghl_webhook_url`). El backend hace `fetch` a esa URL, así que un valor
 * malicioso podría apuntar a servicios internos (metadata de la nube, localhost,
 * rangos privados). Exigimos `https` y bloqueamos destinos internos.
 *
 * Nota: esto NO protege frente a DNS rebinding (un dominio público que resuelve a
 * una IP privada). Para el caso de GHL basta con exigir https + bloquear hosts
 * internos evidentes y NO seguir redirecciones en el `fetch`.
 */

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./, // loopback
  /^0\.0\.0\.0$/,
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 172.16.0.0/12
  /^169\.254\./, // link-local (incluye metadata 169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc00:/i, // IPv6 ULA
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA
];

/**
 * Valida una URL de webhook de salida. Lanza `BadRequestException` si no es
 * segura. Devuelve la URL normalizada (string) si es válida.
 */
export function assertSafeWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('La URL del webhook no es válida');
  }

  if (url.protocol !== 'https:') {
    throw new BadRequestException('La URL del webhook debe usar https');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) {
    throw new BadRequestException('La URL del webhook apunta a un destino no permitido');
  }

  return url.toString();
}

/**
 * Variante que no lanza: devuelve la URL si es segura o `null` si no lo es.
 * Útil en rutas best-effort (p.ej. el envío del webhook) para descartar en
 * silencio valores heredados/no válidos sin romper el flujo.
 */
export function safeWebhookUrlOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return assertSafeWebhookUrl(raw);
  } catch {
    return null;
  }
}
