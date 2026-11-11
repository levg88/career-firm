import { imageGeneration } from './imageGeneration';
import { LinkedInService } from './linkedin';

export interface GeneratedPost {
  theme: string;
  text: string;
  image: ReturnType<typeof imageGeneration.generate>;
  published: boolean;
}

export const postGeneration = {
  generate(theme: string): GeneratedPost {
    const image = imageGeneration.generate(theme);
    const text = `New post about ${theme}: insights and updates. #${theme.replace(/\s+/g, '')}`;
    return {
      theme,
      text,
      image,
      published: false,
    };
  },

  async generateAsync(theme: string): Promise<GeneratedPost> {
    const image = await imageGeneration.generateAsync(theme);
    const text = `New post about ${theme}: insights and updates. #${theme.replace(/\s+/g, '')}`;
    return {
      theme,
      text,
      image,
      published: false,
    };
  },

  async generateAndPublish(theme: string): Promise<GeneratedPost> {
    const post = await this.generateAsync(theme);
    const linkedin = new LinkedInService();
    await linkedin.publishPost(post.text, post.image.url);
    post.published = true;
    return post;
  },

  daily(): GeneratedPost {
    const theme = 'Daily Update';
    return this.generate(theme);
  },

  async dailyAsync(): Promise<GeneratedPost> {
    return this.generateAsync('Daily Update');
  },

  async dailyAndPublish(): Promise<GeneratedPost> {
    const post = await this.dailyAsync();
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