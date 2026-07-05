/**
 * Tipos del procesamiento asíncrono de mensajería. Ya no usamos BullMQ/Redis:
 * el debounce vive en `conversations.respond_after` y los envíos proactivos en
 * la tabla `outbox`; un cron los drena. Estos tipos siguen describiendo el
 * "trabajo" que se procesa en cada caso.
 */

/** Ventana de agrupado: espera tras el último mensaje del lead antes de responder. */
export const DEBOUNCE_MS = 12_000;

/** Datos para generar la respuesta agrupada de una conversación. */
export type RespondJob = {
  orgId: string;
  conversationId: string;
  chatId: string;
  provider: string;
};

/** Datos de un envío del outbox (primer contacto proactivo o respuesta directa). */
export type OutgoingJob = {
  orgId: string;
  conversationId: string;
  content: string;
  /** Tubería de envío ('unipile' | 'whatsapp_cloud' | 'manychat' | 'ghl'). */
  transport?: string;
  /** 'reply' = mensaje en chat existente; 'proactive' = primer contacto. */
  kind?: 'reply' | 'proactive';
  /** Para 'reply': chat de Unipile donde enviamos. */
  chatId?: string;
  /** Para 'proactive': cuenta de Unipile y destinatario (teléfono/handle). */
  accountId?: string;
  attendeeId?: string;
};
