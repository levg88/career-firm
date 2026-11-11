import fs from 'node:fs';
import path from 'node:path';

export interface GeneratedImage {
  url: string;
  theme: string;
  prompt: string;
  path?: string;
}

const DEFAULT_LOCAL_SD_URL = 'http://127.0.0.1:7860/sdapi/v1/txt2img';

function slugify(theme: string): string {
  return theme.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'image';
}

function concisePrompt(theme: string): string {
  const cleaned = theme.replace(/\s+/g, ' ').trim();
  const brief = cleaned.length > 180 ? `${cleaned.slice(0, 177)}…` : cleaned;
  return `Professional, modern, eye-catching LinkedIn post image about: ${brief}. Clean composition, high quality, no text.`;
}

function placeholder(theme: string): GeneratedImage {
  const prompt = concisePrompt(theme);
  return {
    url: `https://generated.local/images/${slugify(theme)}.png`,
    theme,
    prompt,
  };
}

function saveImage(dir: string, slug: string, data: Buffer): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}-${Date.now()}.png`);
  fs.writeFileSync(filePath, data);
  return filePath;
}

async function tryLocalSd(prompt: string, slug: string): Promise<string | null> {
  const url = process.env.LOCAL_SD_URL || DEFAULT_LOCAL_SD_URL;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, steps: 20, width: 1024, height: 1024 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { images?: string[] };
    const base64 = data.images?.[0];
    if (!base64) return null;
    return saveImage(path.join(process.cwd(), 'data', 'generated'), slug, Buffer.from(base64, 'base64'));
  } catch {
    return null;
  }
}

async function tryPollinations(prompt: string, slug: string): Promise<string | null> {
  try {
    const url =
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
      '?width=1024&height=1024&nologo=true';
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length < 1000) return null;
    return saveImage(path.join(process.cwd(), 'data', 'generated'), slug, buf);
  } catch {
    return null;
  }
}

export const imageGeneration = {
  generate(theme: string): GeneratedImage {
    return placeholder(theme);
  },

  async generateAsync(theme: string): Promise<GeneratedImage> {
    const prompt = concisePrompt(theme);
    const slug = slugify(theme);
    if (process.env.NODE_ENV === 'test') return placeholder(theme);

    const local = await tryLocalSd(prompt, slug);
    if (local) {
      return { url: `file://${local}`, theme, prompt, path: local };
    }

    const fallback = await tryPollinations(prompt, slug);
    if (fallback) {
      return { url: `file://${fallback}`, theme, prompt, path: fallback };
    }

    return placeholder(theme);
  },

  generateImage(theme: string): GeneratedImage {
    return this.generate(theme);
  },

  async generateImageAsync(theme: string): Promise<GeneratedImage> {
    return this.generateAsync(theme);
  },

  create(theme: string): GeneratedImage {
    return this.generate(theme);
  },
};

export function generateImage(theme: string): GeneratedImage {
  return imageGeneration.generate(theme);
}

export async function generateImageAsync(theme: string): Promise<GeneratedImage> {
  return imageGeneration.generateAsync(theme);
}

export default imageGeneration;