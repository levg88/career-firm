/**
 * @file Text extraction from DOCX/PDF/TXT/Markdown files.
 *
 * Provides {@link extractText} and format-specific extractors plus {@link cleanText}
 * and {@link excerpt} helpers used when importing CVs and job descriptions.
 */

import fs from 'node:fs';
import path from 'node:path';

import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

/** Error thrown when a document cannot be read or parsed. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/** Normalise extracted text: unify line endings, collapse whitespace, trim. */
export function cleanText(text: string): string {
  let value = String(text ?? '');
  value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  value = value.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
  value = value.replace(/[ \t]+/g, ' ');
  value = value.replace(/\n[ \t]+/g, '\n');
  value = value.replace(/\n{3,}/g, '\n\n');
  return value.trim();
}

/** Extract plain text from a DOCX file. */
export async function extractDocx(file: string): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ path: file });
    return cleanText(result.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExtractionError(`Could not read DOCX: ${message}`);
  }
}

/** Extract plain text from a PDF file. */
export async function extractPdf(file: string): Promise<string> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: fs.readFileSync(file) });
    const result = await parser.getText();
    return cleanText(result.text ?? '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExtractionError(`Could not read PDF: ${message}`);
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

/** Extract text from a file based on its extension. */
export async function extractText(file: string): Promise<string> {
  const suffix = path.extname(file).toLowerCase();
  if (suffix === '.docx') return extractDocx(file);
  if (suffix === '.pdf') return extractPdf(file);
  if (['.txt', '.md', '.markdown'].includes(suffix)) {
    try {
      return cleanText(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ExtractionError(`Could not read ${path.basename(file)}: ${message}`);
    }
  }
  if (suffix === '.doc') {
    throw new ExtractionError(
      'Legacy .doc files are not supported. Save the file as .docx or PDF and retry.',
    );
  }
  throw new ExtractionError(
    `Unsupported file type '${suffix || 'unknown'}'. Use DOCX, PDF, TXT, or Markdown.`,
  );
}

/** Return a cleaned, length-limited excerpt of text. */
export function excerpt(text: string, limit = 12000): string {
  const value = cleanText(text);
  if (value.length <= limit) return value;
  const clipped = value.slice(0, limit);
  const lastBreak = clipped.lastIndexOf('\n');
  return `${lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped}\n… [truncated]`;
}
