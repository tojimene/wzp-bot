import path from "node:path";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// `connect-src`: en producción solo https/wss (API en Vercel + Supabase realtime).
// En desarrollo añadimos http/ws a localhost para poder llamar a la API local
// (http://localhost:3001) y para el hot-reload de Next.
const connectSrc = isDev
  ? "connect-src 'self' https: wss: http://localhost:* ws://localhost:*"
  : "connect-src 'self' https: wss:";

const nextConfig: NextConfig = {
  // En un monorepo, la raíz del workspace está dos niveles por encima.
  // Esto evita avisos de "additional lockfiles" y mejora el file tracing.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Permite usar paquetes del workspace (TypeScript sin precompilar).
  transpilePackages: ["@wzp/shared"],

  // Cabeceras de seguridad del navegador para todo el frontend.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Anti-clickjacking (el dashboard no debe embeberse en iframes).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // Fuerza HTTPS durante 2 años (incluye subdominios).
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          // CSP mínima: bloquea que la app sea embebida (frame-ancestors) y
          // restringe orígenes. 'unsafe-inline'/'unsafe-eval' son necesarios
          // para el runtime de Next; endurecer con nonces en el futuro.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              connectSrc,
              "frame-src https://www.facebook.com https://web.facebook.com",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
