import { imageGeneration } from './imageGeneration';
import { LinkedInService } from './linkedin';
import type { LLMClient } from '../llm/base';

export interface PostGenerator {
  complete(
    messages: Record<string, any>[],
    options?: Record<string, any>,
  ): Promise<{ text: string }>;
}

function postPrompt(theme: string, context?: string): Record<string, any>[] {
  const background = (context || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const messages: Record<string, any>[] = [
    {
      role: 'system',
      content:
        'You are an expert LinkedIn ghostwriter for a senior technology executive (VP R&D / CTO). ' +
        'Write a post that sounds like a real person, not generic AI output. ' +
        'Rules: start with a punchy hook of 12 words or fewer on its own line; use 2-4 short paragraphs; ' +
        'ground claims in concrete experience or specific examples; avoid buzzwords, clichés, and phrases like ' +
        '"in today\'s fast-paced world"; do not bold text; no emojis; end with a genuine question; ' +
        'finish with 3 relevant hashtags. Do NOT restate the brief verbatim, do not mention being an AI, ' +
        'and return only the post text. Aim for 140-200 words.',
    },
    {
      role: 'user',
      content:
        (background ? `Author background (use only if relevant):\n${background}\n\n` : '') +
        `Theme / brief for the post:\n${theme}`,
    },
  ];
  return messages;
}

function templatePost(theme: string): string {
  return `New post about ${theme}: insights and updates. #${theme.replace(/\s+/g, '')}`;
}

export interface GeneratedPost {
  theme: string;
  text: string;
  image: ReturnType<typeof imageGeneration.generate>;
  published: boolean;
}

export const postGeneration = {
  generate(theme: string): GeneratedPost {
    const image = imageGeneration.generate(theme);
    return {
      theme,
      text: templatePost(theme),
      image,
      published: false,
    };
  },

  async generateAsync(
    theme: string,
    llm?: LLMClient | PostGenerator,
    context?: string,
  ): Promise<GeneratedPost> {
    const image = await imageGeneration.generateAsync(theme);
    let text = templatePost(theme);
    if (llm) {
      try {
        const response = await llm.complete(postPrompt(theme, context), { temperature: 0.8 });
        const generated = (response.text || '').trim();
        if (generated) text = generated;
      } catch {
        // Fall back to the template if the model is unavailable.
      }
    }
    return {
      theme,
      text,
      image,
      published: false,
    };
  },

  async generateAndPublish(
    theme: string,
    llm?: LLMClient | PostGenerator,
    context?: string,
  ): Promise<GeneratedPost> {
    const post = await this.generateAsync(theme, llm, context);
    const linkedin = new LinkedInService();
    await linkedin.publishPost(post.text, post.image.url);
    post.published = true;
    return post;
  },

  daily(): GeneratedPost {
    const theme = 'Daily Update';
    return this.generate(theme);
  },

  async dailyAsync(llm?: LLMClient | PostGenerator, context?: string): Promise<GeneratedPost> {
    return this.generateAsync('Daily Update', llm, context);
  },

  async dailyAndPublish(llm?: LLMClient | PostGenerator, context?: string): Promise<GeneratedPost> {
    const post = await this.dailyAsync(llm, context);
    const linkedin = new LinkedInService();
    await linkedin.publishPost(post.text, post.image.url);
    post.published = true;
    return post;
  },
};

export function generatePost(theme: string): GeneratedPost {
  return postGeneration.generate(theme);
}

export default postGeneration;