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
  return theme.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image';
}

function placeholder(theme: string): GeneratedImage {
  const prompt = `A professional, eye-catching LinkedIn post image about ${theme}`;
  const slug = slugify(theme);
  return {
    url: `https://generated.local/images/${slug}.png`,
    theme,
    prompt,
  };
}

export const imageGeneration = {
  generate(theme: string): GeneratedImage {
    return placeholder(theme);
  },

  async generateAsync(theme: string): Promise<GeneratedImage> {
    const prompt = `A professional, eye-catching LinkedIn post image about ${theme}`;
    const url = process.env.LOCAL_SD_URL || DEFAULT_LOCAL_SD_URL;
    const slug = slugify(theme);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          steps: 20,
          width: 1024,
          height: 1024,
        }),
      });
      if (!response.ok) throw new Error(`Local SD returned ${response.status}`);
      const data = (await response.json()) as { images?: string[] };
      const base64 = data.images?.[0];
      if (!base64) throw new Error('No image returned');
      const dir = path.join(process.cwd(), 'data', 'generated');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${slug}-${Date.now()}.png`);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      return {
        url: `file://${filePath}`,
        theme,
        prompt,
        path: filePath,
      };
    } catch {
      return placeholder(theme);
    }
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