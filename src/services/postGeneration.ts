import { imageGeneration } from './imageGeneration';
import { LinkedInService } from './linkedin';
import type { LLMClient } from '../llm/base';

export interface PostGenerator {
  complete(
    messages: Record<string, any>[],
    options?: Record<string, any>,
  ): Promise<{ text: string }>;
}

function postPrompt(theme: string): Record<string, any>[] {
  return [
    {
      role: 'system',
      content:
        'You are an expert LinkedIn ghostwriter for a senior technology executive. ' +
        'Write a polished, authentic LinkedIn post in the first person. Requirements: ' +
        'a strong hook in the first line, 3-4 short paragraphs or a compact list of insights, ' +
        'a concrete takeaway, a question or call to action at the end, and 3-5 relevant hashtags. ' +
        'Do NOT restate the brief verbatim and do NOT mention that you are an AI. ' +
        'Keep it between 150 and 250 words. Return only the post text.',
    },
    {
      role: 'user',
      content: `Theme / brief for the post:\n${theme}`,
    },
  ];
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

  async generateAsync(theme: string, llm?: LLMClient | PostGenerator): Promise<GeneratedPost> {
    const image = await imageGeneration.generateAsync(theme);
    let text = templatePost(theme);
    if (llm) {
      try {
        const response = await llm.complete(postPrompt(theme), { temperature: 0.7 });
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

  async generateAndPublish(theme: string, llm?: LLMClient | PostGenerator): Promise<GeneratedPost> {
    const post = await this.generateAsync(theme, llm);
    const linkedin = new LinkedInService();
    await linkedin.publishPost(post.text, post.image.url);
    post.published = true;
    return post;
  },

  daily(): GeneratedPost {
    const theme = 'Daily Update';
    return this.generate(theme);
  },

  async dailyAsync(llm?: LLMClient | PostGenerator): Promise<GeneratedPost> {
    return this.generateAsync('Daily Update', llm);
  },

  async dailyAndPublish(llm?: LLMClient | PostGenerator): Promise<GeneratedPost> {
    const post = await this.dailyAsync(llm);
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