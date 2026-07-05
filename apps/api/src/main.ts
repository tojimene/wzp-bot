import { execSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * Crea y CONFIGURA la app Nest (middleware, prefijo, CORS, validación) sin
 * escuchar en un puerto. La reutilizan tanto `bootstrap()` (local / hosts con
 * proceso persistente) como el entry serverless de Vercel (`api/index.js`), que
 * llama a `app.init()` y usa la instancia Express como handler.
 */
export async function createNestApp() {
  // Gestionamos el parseo del body nosotros (ver más abajo el caso webhooks).
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  // Cabeceras de seguridad (HSTS, X-Content-Type-Options, etc.). Es una API
  // JSON, así que no necesitamos CSP de navegador ni recursos cross-origin.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Los webhooks de Unipile a veces NO llegan con content-type application/json,
  // y el parser por defecto los trata como formulario y rompe el JSON (account_id
  // sale undefined). Para esas rutas forzamos parseo JSON sea cual sea el header.
  app.use(
    '/api/webhooks',
    json({
      type: () => true,
      limit: '2mb',
      // Guardamos el cuerpo crudo para verificar firmas HMAC (Meta X-Hub-Signature-256).
      verify: (req: IncomingMessage, _res: ServerResponse, buf: Buffer) => {
        (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  // Resto de rutas: parseo normal con límites ajustados. (La subida de archivos
  // usa multipart y la gestiona multer, así que estos parsers la ignoran.)
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // Prefijo común para todos los endpoints: /api/...
  app.setGlobalPrefix('api');

  // CORS estricto: solo los orígenes en la allowlist (WEB_URL admite varios
  // separados por comas, p.ej. landing + app). Sin orígenes => mismo-origen.
  const origins = (config.get<string>('CORS_ORIGINS') ?? config.get<string>('WEB_URL') ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  });

  // Valida y limpia automáticamente los datos de entrada (DTOs).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
    }),
  );

  return app;
}

/** Arranca la API como servidor con proceso persistente (local / Render / etc.). */
async function bootstrap() {
  const app = await createNestApp();
  const config = app.get(ConfigService);

  // Cierre limpio: al reiniciar el watcher, liberamos el puerto de inmediato.
  app.enableShutdownHooks();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void app.close().finally(() => process.exit(0));
    });
  }

  // Los hosts gestionados (Render, Railway, Fly, etc.) inyectan PORT y esperan
  // que la app escuche ahí. En local usamos API_PORT (3001) del .env.
  const port = Number(process.env.PORT) || config.get<number>('API_PORT') || 3001;
  // En dev, el watcher reinicia y a veces el proceso anterior tarda en soltar
  // el puerto. Reintentamos en vez de morir con EADDRINUSE.
  await listenWithRetry(app, port);

  // eslint-disable-next-line no-console
  console.log(`API escuchando en http://localhost:${port}/api`);
}

async function listenWithRetry(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  port: number,
  attempts = 8,
) {
  const isProd = process.env.NODE_ENV === 'production';
  for (let i = 0; i < attempts; i++) {
    try {
      await app.listen(port);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'EADDRINUSE' && i < attempts - 1) {
        // En dev, el watcher a veces deja un proceso huérfano ocupando el
        // puerto. Lo matamos para poder tomar el control nosotros.
        if (!isProd) freePort(port);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
  }
}

/** Mata los procesos que estén escuchando en el puerto (excepto el actual). */
function freePort(port: number) {
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    for (const pid of out.split('\n')) {
      const n = Number(pid);
      if (n && n !== process.pid) {
        try {
          process.kill(n, 'SIGKILL');
        } catch {
          // ya no existe
        }
      }
    }
  } catch {
    // lsof no encontró nada / no disponible
  }
}

// Solo arrancamos el servidor cuando este archivo es el punto de entrada
// (local / `node dist/main` en Render). En Vercel se importa `createNestApp`
// desde el handler serverless, que NO debe abrir un puerto.
if (require.main === module) {
  void bootstrap();
}
