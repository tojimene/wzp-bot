import { BadRequestException } from '@nestjs/common';

/**
 * Extrae el texto plano de un documento subido (PDF, DOCX o TXT) para que la
 * IA pueda analizarlo y rellenar la configuración del setter.
 *
 * IMPORTANTE: `pdf-parse` (pdfjs) y `mammoth` se cargan de forma PEREZOSA con
 * `import()` dinámico dentro de cada rama, no en la cima del módulo. En un
 * entorno serverless (Vercel) el `import` estático de `pdf-parse` ejecuta pdfjs
 * al cargar y revienta con `DOMMatrix is not defined`, tumbando el arranque de
 * toda la API. Al cargarlo solo cuando se parsea un archivo, el arranque queda
 * libre y estas libs pesadas no penalizan el cold start del resto de rutas.
 */
export async function extractTextFromFile(file: {
  originalname?: string;
  mimetype?: string;
  buffer: Buffer;
}): Promise<string> {
  const name = (file.originalname ?? '').toLowerCase();
  const mime = file.mimetype ?? '';

  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
    try {
      const result = await parser.getText();
      return result.text ?? '';
    } finally {
      await parser.destroy();
    }
  }

  if (
    name.endsWith('.docx') ||
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return value ?? '';
  }

  if (
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.markdown') ||
    mime.startsWith('text/') ||
    mime === 'text/markdown'
  ) {
    return file.buffer.toString('utf8');
  }

  if (name.endsWith('.doc')) {
    throw new BadRequestException(
      'El formato .doc antiguo no es compatible. Guárdalo como .docx o PDF.',
    );
  }

  throw new BadRequestException(
    'Formato no soportado. Sube un PDF, un Word (.docx), un .txt o un .md.',
  );
}
