import fs from 'node:fs';
import path from 'node:path';

import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import { PDFDocument } from 'pdf-lib';
import PDFKit from 'pdfkit';

import type { EducationItem, ExperienceItem, TailoredCV } from '../models';
import { cleanText } from './extract';

export const RTL_LANGUAGES = new Set(['he', 'ar', 'fa', 'ur']);

const MM_TO_PT = 2.834645669291339;

function plain(text: unknown): string {
  let value = String(text ?? '');
  value = value.replace(/\*\*(.+?)\*\*/g, '$1');
  value = value.replace(/__(.+?)__/g, '$1');
  value = value.replace(/`(.+?)`/g, '$1');
  value = value.replace(/^#{1,6}\s*/, '');
  value = value.replace(/\u00a0/g, ' ');
  return value.replace(/[ \t]+/g, ' ').trim();
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'cv';
}

function contactLine(cv: TailoredCV): string {
  const contact = cv.contact;
  return [contact.location, contact.email, contact.phone, contact.linkedin, contact.website]
    .map(plain)
    .filter(Boolean)
    .join(' | ');
}

const ACRONYMS: Record<string, string> = {
  ai: 'AI', ml: 'ML', llm: 'LLM', llms: 'LLMs', saas: 'SaaS',
  b2b: 'B2B', b2c: 'B2C', 'p&l': 'P&L', vp: 'VP', svp: 'SVP',
  evp: 'EVP', cto: 'CTO', ceo: 'CEO', cfo: 'CFO', coo: 'COO',
  cio: 'CIO', cro: 'CRO', cmo: 'CMO', aws: 'AWS', gcp: 'GCP',
  sql: 'SQL', api: 'API', apis: 'APIs', etl: 'ETL', devops: 'DevOps',
  kubernetes: 'Kubernetes', python: 'Python', java: 'Java',
};

function displayTerm(term: string): string {
  return plain(term)
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower in ACRONYMS) return ACRONYMS[lower];
      if (word === word.toLowerCase()) return word.slice(0, 1).toUpperCase() + word.slice(1);
      return word;
    })
    .join(' ');
}

function experienceHeading(item: ExperienceItem): string {
  const left = [plain(item.company), plain(item.title)].filter(Boolean).join(' — ');
  const dates = [plain(item.start), plain(item.end)].filter(Boolean).join(' – ');
  const bits = left ? [left] : [];
  if (dates) bits.push(dates);
  return bits.join(' | ');
}

type SectionRow =
  | { kind: 'para'; text: string; items: string[] }
  | { kind: 'inline'; text: string; items: string[] }
  | { kind: 'bullets'; text: string; items: string[] }
  | { kind: 'section'; text: string; items: string[] }
  | { kind: 'experience'; text: string; items: ExperienceItem[] }
  | { kind: 'education'; text: string; items: EducationItem[] };

/** Yield rows in the canonical ATS-friendly order. */
function sectionRows(cv: TailoredCV): SectionRow[] {
  const rows: SectionRow[] = [];
  if (cv.summary.trim()) rows.push({ kind: 'para', text: plain(cv.summary), items: [] });
  if (cv.core_competencies.length) {
    rows.push({
      kind: 'inline',
      text: 'CORE COMPETENCIES',
      items: cv.core_competencies.filter((x) => plain(x)).map(displayTerm),
    });
  }
  if (cv.experience.length) {
    rows.push({ kind: 'section', text: 'PROFESSIONAL EXPERIENCE', items: [] });
    for (const item of cv.experience) rows.push({ kind: 'experience', text: '', items: [item] });
  }
  if (cv.education.length) {
    rows.push({ kind: 'section', text: 'EDUCATION', items: [] });
    for (const item of cv.education) rows.push({ kind: 'education', text: '', items: [item] });
  }
  if (cv.certifications.length) {
    rows.push({
      kind: 'bullets',
      text: 'CERTIFICATIONS',
      items: cv.certifications.filter((x) => plain(x)).map(plain),
    });
  }
  if (cv.skills.length) {
    rows.push({
      kind: 'inline',
      text: 'SKILLS',
      items: cv.skills.filter((x) => plain(x)).map(displayTerm),
    });
  }
  if (cv.languages.length) {
    rows.push({
      kind: 'inline',
      text: 'LANGUAGES',
      items: cv.languages.filter((x) => plain(x)).map(displayTerm),
    });
  }
  return rows;
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

const pt = (points: number): number => Math.round(points * 20); // twips
const halfPoints = (points: number): number => Math.max(2, Math.round(points * 2));
const inches = (value: number): number => Math.round(value * 1440);

export async function renderDocx(cv: TailoredCV, file: string, scale = 1.0): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const children: Paragraph[] = [];

  const paragraph = (
    text = '',
    options: {
      size?: number;
      bold?: boolean;
      italic?: boolean;
      color?: string;
      spaceBefore?: number;
      spaceAfter?: number;
      align?: (typeof AlignmentType)[keyof typeof AlignmentType];
      indent?: number;
      border?: Paragraph['options']['border'];
    } = {},
  ): Paragraph => {
    const runs = text
      ? [
          new TextRun({
            text,
            bold: options.bold ?? false,
            italics: options.italic ?? false,
            size: options.size ? halfPoints(options.size) : undefined,
            color: options.color,
            font: 'Calibri',
          }),
        ]
      : [];
    return new Paragraph({
      children: runs,
      alignment: options.align,
      spacing: {
        before: pt(options.spaceBefore ?? 0),
        after: pt(options.spaceAfter ?? 0),
      },
      indent:
        options.indent !== undefined
          ? { left: inches(options.indent), hanging: inches(options.indent) }
          : undefined,
      border: options.border,
    });
  };

  const heading = (title: string): void => {
    children.push(
      paragraph(title.toUpperCase(), {
        size: 10.2 * scale,
        bold: true,
        spaceBefore: 6.5 * scale,
        spaceAfter: 1.5 * scale,
        color: '222222',
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA', space: 1 },
        },
      }),
    );
  };

  const bullet = (text: string): void => {
    children.push(
      paragraph(`• ${plain(text)}`, {
        size: 9.9 * scale,
        indent: 0.17,
        spaceAfter: 0.6 * scale,
      }),
    );
  };

  // Header
  children.push(
    paragraph(plain(cv.name) || 'Candidate', {
      size: 19 * scale,
      bold: true,
      spaceAfter: 1,
      color: '111111',
    }),
  );
  if (cv.headline) {
    children.push(
      paragraph(plain(cv.headline), {
        size: 10.8 * scale,
        italic: true,
        spaceAfter: 1.5,
        color: '333333',
      }),
    );
  }
  const contact = contactLine(cv);
  if (contact) {
    children.push(paragraph(contact, { size: 9.0 * scale, spaceAfter: 2, color: '444444' }));
  }

  for (const row of sectionRows(cv)) {
    if (row.kind === 'para') {
      heading('PROFESSIONAL SUMMARY');
      children.push(paragraph(row.text, { size: 9.9 * scale, spaceAfter: 1 }));
    } else if (row.kind === 'inline') {
      heading(row.text);
      children.push(paragraph(row.items.join(', '), { size: 9.6 * scale, spaceAfter: 1 }));
    } else if (row.kind === 'bullets') {
      heading(row.text);
      for (const item of row.items) bullet(item);
    } else if (row.kind === 'section') {
      heading(row.text);
    } else if (row.kind === 'experience') {
      const item = row.items[0];
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: experienceHeading(item),
              bold: true,
              size: halfPoints(10.0 * scale),
              font: 'Calibri',
            }),
          ],
          spacing: { before: 0, after: pt(0.5) },
        }),
      );
      if (item.location || item.context) {
        const sub = [plain(item.location), plain(item.context)].filter(Boolean).join(' | ');
        if (sub) {
          children.push(
            paragraph(sub, {
              size: 8.9 * scale,
              italic: true,
              spaceAfter: 1,
              color: '555555',
            }),
          );
        }
      }
      for (const line of item.bullets) bullet(line);
    } else if (row.kind === 'education') {
      const item = row.items[0];
      const left = [plain(item.institution), plain(item.degree)].filter(Boolean).join(' — ');
      const bits = left ? [left] : [];
      if (item.location) bits.push(plain(item.location));
      if (item.year) bits.push(plain(item.year));
      children.push(
        paragraph(bits.join(' | '), {
          size: 9.8 * scale,
          bold: Boolean(left),
          spaceAfter: 0.5,
        }),
      );
      if (item.details) {
        children.push(paragraph(plain(item.details), { size: 9.2 * scale, spaceAfter: 0.5 }));
      }
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: halfPoints(10.2 * scale), color: '1A1A1A' },
          paragraph: { spacing: { before: 0, after: 0, line: Math.round(240 * 1.03) } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: inches(0.55),
              bottom: inches(0.5),
              left: inches(0.65),
              right: inches(0.65),
            },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(file, buffer);
  return file;
}

// ── PDF ──────────────────────────────────────────────────────────────────────

function fontCandidates(fontPath?: string | null): Record<string, string> {
  const candidates: Record<string, string>[] = [];
  if (fontPath && fs.existsSync(fontPath) && fs.statSync(fontPath).isFile()) {
    candidates.push({ '': fontPath, B: fontPath, I: fontPath, BI: fontPath });
  }

  if (process.platform === 'darwin') {
    const base = '/System/Library/Fonts/Supplemental';
    candidates.push({
      '': `${base}/Arial.ttf`,
      B: `${base}/Arial Bold.ttf`,
      I: `${base}/Arial Italic.ttf`,
      BI: `${base}/Arial Bold Italic.ttf`,
    });
  } else if (process.platform === 'win32') {
    const base = 'C:/Windows/Fonts';
    candidates.push({
      '': `${base}/arial.ttf`,
      B: `${base}/arialbd.ttf`,
      I: `${base}/ariali.ttf`,
      BI: `${base}/arialbi.ttf`,
    });
  }
  candidates.push({
    '': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    B: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    I: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    BI: '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf',
  });

  for (const family of candidates) {
    if (family[''] && fs.existsSync(family[''])) {
      const out: Record<string, string> = {};
      for (const [style, file] of Object.entries(family)) {
        if (file && fs.existsSync(file)) out[style] = file;
      }
      return out;
    }
  }
  return {};
}

const HELVETICA: Record<string, string> = {
  '': 'Helvetica',
  B: 'Helvetica-Bold',
  I: 'Helvetica-Oblique',
  BI: 'Helvetica-BoldOblique',
};

export async function renderPdf(
  cv: TailoredCV,
  file: string,
  scale = 1.0,
  fontPath?: string | null,
): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const leftMargin = 16.5 * MM_TO_PT;
  const rightMargin = 16.5 * MM_TO_PT;
  const topMargin = 13.5 * MM_TO_PT;
  const bottomMargin = 12.5 * MM_TO_PT;

  const doc = new PDFKit({
    size: 'LETTER',
    margins: { top: topMargin, bottom: bottomMargin, left: leftMargin, right: rightMargin },
    autoFirstPage: true,
  });

  const fonts = fontCandidates(fontPath);
  const family: Record<string, string> = {};
  if (Object.keys(fonts).length) {
    for (const [style, fontFile] of Object.entries(fonts)) {
      const name = `CVFont${style ? `-${style}` : ''}`;
      doc.registerFont(name, fontFile);
      family[style] = name;
    }
  } else {
    Object.assign(family, HELVETICA);
  }

  const rtl = RTL_LANGUAGES.has(String(cv.language || 'en').toLowerCase().slice(0, 2));
  const align: 'left' | 'right' = rtl ? 'right' : 'left';
  const contentWidth = doc.page.width - leftMargin - rightMargin;

  const setFont = (style: string, size: number): void => {
    const name = family[style] ?? family[''];
    doc.font(name).fontSize(size * scale);
  };

  const textBlock = (
    text: string,
    size: number,
    style = '',
    height = 1.28,
    spaceAfter = 0,
  ): void => {
    setFont(style, size);
    const lineGap = Math.max(0, (height - 1.2) * size * scale);
    doc.text(plain(text), {
      width: contentWidth,
      align,
      lineGap,
    });
    if (spaceAfter) doc.y += spaceAfter * scale * MM_TO_PT;
  };

  const heading = (title: string): void => {
    doc.y += 2.6 * scale * MM_TO_PT;
    setFont('B', 9.8);
    const y = doc.y;
    doc.text(title.toUpperCase(), { width: contentWidth, align });
    doc
      .save()
      .strokeColor('#AAAAAA')
      .lineWidth(0.18)
      .moveTo(leftMargin, y)
      .lineTo(doc.page.width - rightMargin, y)
      .stroke()
      .restore();
    doc.y += 0.9 * scale * MM_TO_PT;
  };

  const bullet = (text: string): void => {
    setFont('', 9.6);
    const indent = 3.2 * MM_TO_PT;
    doc.text(`• ${plain(text)}`, leftMargin + indent, doc.y, {
      width: contentWidth - indent,
      align,
      lineGap: Math.max(0, (1.26 - 1.2) * 9.6 * scale),
    });
  };

  // Header
  doc.fillColor('#111111');
  textBlock(plain(cv.name) || 'Candidate', 18.5, 'B', 1.28, 0.4);
  if (cv.headline) {
    doc.fillColor('#333333');
    textBlock(cv.headline, 10.4, 'I', 1.28, 0.6);
  }
  const contact = contactLine(cv);
  if (contact) {
    doc.fillColor('#444444');
    textBlock(contact, 8.6, '', 1.28, 0.5);
  }
  doc.fillColor('#1A1A1A');

  for (const row of sectionRows(cv)) {
    if (row.kind === 'para') {
      heading('Professional Summary');
      textBlock(row.text, 9.6, '', 1.28, 0.6);
    } else if (row.kind === 'inline') {
      heading(row.text);
      textBlock(row.items.join(', '), 9.2, '', 1.28, 0.6);
    } else if (row.kind === 'bullets') {
      heading(row.text);
      for (const item of row.items) bullet(item);
    } else if (row.kind === 'section') {
      heading(row.text);
    } else if (row.kind === 'experience') {
      const item = row.items[0];
      setFont('B', 9.8);
      doc.text(plain(experienceHeading(item)), { width: contentWidth, align });
      const sub = [plain(item.location), plain(item.context)].filter(Boolean).join(' | ');
      if (sub) {
        doc.fillColor('#555555');
        textBlock(sub, 8.5, 'I', 1.28, 0.3);
        doc.fillColor('#1A1A1A');
      }
      for (const line of item.bullets) bullet(line);
    } else if (row.kind === 'education') {
      const item = row.items[0];
      const left = [plain(item.institution), plain(item.degree)].filter(Boolean).join(' — ');
      const bits = left ? [left] : [];
      if (item.location) bits.push(plain(item.location));
      if (item.year) bits.push(plain(item.year));
      setFont(left ? 'B' : '', 9.5);
      doc.text(bits.join(' | '), { width: contentWidth, align });
      if (item.details) textBlock(item.details, 8.7, '', 1.28, 0.3);
    }
  }

  const finished = new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(file);
    stream.on('finish', () => resolve());
    stream.on('error', reject);
    doc.pipe(stream);
    doc.end();
  });
  await finished;
  return file;
}

export async function pageCount(file: string): Promise<number> {
  try {
    const bytes = fs.readFileSync(file);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch {
    return 0;
  }
}

export interface RenderResult {
  docx_path: string;
  pdf_path: string;
  pages: number;
  scale: number;
}

/** Render matching DOCX + PDF, shrinking until the PDF fits maxPages. */
export async function renderCv(
  cv: TailoredCV,
  outDir: string,
  basename: string,
  options: { fontPath?: string | null; maxPages?: number } = {},
): Promise<RenderResult> {
  fs.mkdirSync(outDir, { recursive: true });
  const stem = safeName(basename);
  const docxPath = path.join(outDir, `${stem}.docx`);
  const pdfPath = path.join(outDir, `${stem}.pdf`);
  const maxPages = options.maxPages ?? 2;

  let chosenScale = 1.0;
  let pages = 0;
  for (const scale of [1.0, 0.95, 0.9, 0.86, 0.82]) {
    await renderPdf(cv, pdfPath, scale, options.fontPath);
    pages = await pageCount(pdfPath);
    chosenScale = scale;
    if (pages && pages <= maxPages) break;
  }

  await renderDocx(cv, docxPath, chosenScale);
  return {
    docx_path: docxPath,
    pdf_path: pdfPath,
    pages,
    scale: chosenScale,
  };
}

export { cleanText };
