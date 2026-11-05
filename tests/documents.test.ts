import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { describe, expect, it } from 'vitest';

import { extractText } from '../src/documents/extract';
import {
  analyzeJobHeuristic,
  parseCvHeuristic,
  tailorHeuristic,
} from '../src/documents/heuristics';
import { pageCount, renderCv } from '../src/documents/render';
import { SAMPLE_CV, SAMPLE_JD } from './helpers';

function tailored() {
  const parsed = parseCvHeuristic(SAMPLE_CV);
  const analysis = analyzeJobHeuristic(SAMPLE_JD, SAMPLE_CV);
  return tailorHeuristic(parsed, analysis, SAMPLE_CV, 'Executive leader.');
}

async function pdfText(file: string): Promise<string> {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  try {
    const result = await parser.getText();
    return result.text ?? '';
  } finally {
    await parser.destroy();
  }
}

describe('documents', () => {
  it('extracts DOCX paragraphs and tables', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-firm-docx-'));
    const file = path.join(directory, 'cv.docx');
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun('Jane Doe')] }),
            new Paragraph({ children: [new TextRun('SUMMARY')] }),
            new Paragraph({ children: [new TextRun('Engineering executive.')] }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({
                      children: [new Paragraph({ children: [new TextRun('Acme Corp')] })],
                    }),
                    new TableCell({
                      children: [
                        new Paragraph({ children: [new TextRun('2020 - Present')] }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });
    fs.writeFileSync(file, await Packer.toBuffer(doc));
    const text = await extractText(file);
    expect(text).toContain('Jane Doe');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('2020 - Present');
  });

  it('extracts markdown', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-firm-md-'));
    const file = path.join(directory, 'cv.md');
    fs.writeFileSync(file, '# Jane Doe\n\nEXPERIENCE\nAcme Corp 2020 - Present', 'utf8');
    expect(await extractText(file)).toContain('Acme Corp');
  });

  it('renders matching PDF and DOCX files', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-firm-render-'));
    const cv = tailored();
    const result = await renderCv(cv, directory, 'jane_doe');

    expect(fs.statSync(result.pdf_path).size).toBeGreaterThan(1000);
    expect(fs.statSync(result.docx_path).size).toBeGreaterThan(1000);
    expect(await pageCount(result.pdf_path)).toBeLessThanOrEqual(2);

    const renderedText = await pdfText(result.pdf_path);
    expect(renderedText).toContain('Jane Doe');
    expect(renderedText).toContain('Acme Corp');
    expect(renderedText).toContain('45');
    expect(renderedText).toContain('CORE COMPETENCIES');

    const docxText = (await mammoth.extractRawText({ path: result.docx_path })).value;
    expect(docxText).toContain('Jane Doe');
    expect(docxText).toContain('Acme Corp');
    expect(docxText).toContain('45');

    const html = (await mammoth.convertToHtml({ path: result.docx_path })).value;
    expect(html).not.toContain('<table');
  });
});
