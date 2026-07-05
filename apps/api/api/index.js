// Entry serverless de la API para Vercel.
//
// Importamos la app YA COMPILADA (nest build → dist) en lugar del código TS:
// así conservamos los metadatos de los decoradores (emitDecoratorMetadata), que
// NestJS necesita para su inyección de dependencias y que los bundlers
// serverless no emiten. Cacheamos la instancia Express entre invocaciones
// "calientes" para evitar rearrancar Nest en cada request.
require('reflect-metadata');

let handlerPromise = null;

async function getHandler() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createNestApp } = require('../dist/main.js');
  const app = await createNestApp();
  await app.init();
  return app.getHttpAdapter().getInstance();
}

module.exports = async (req, res) => {
  try {
    if (!handlerPromise) handlerPromise = getHandler();
    const express = await handlerPromise;
    return express(req, res);
  } catch (err) {
    // Si el arranque de Nest falla, no cacheamos el error (permite reintentar).
    handlerPromise = null;
    // eslint-disable-next-line no-console
    console.error('Fallo al iniciar la API serverless:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    // Exponemos el mensaje para diagnóstico (típicamente "X is not defined" por
    // una variable de entorno que falta). Los nombres de variables no son secretos.
    res.end(
      JSON.stringify({
        error: 'startup_failed',
        message: err && err.message ? String(err.message) : String(err),
      }),
    );
  }
};
