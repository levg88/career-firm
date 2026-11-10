import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../server';

const generatePostUrl = '/posts/generate';
const dailyPostUrl = '/posts/daily';

describe('Post Generation', () => {
  it('should generate a post with the specified theme', async () => {
    const theme = 'Technology';
    const response = await request(app).post(generatePostUrl).send({ theme });
    expect(response.statusCode).toBe(200);
    expect(response.text).toBe(`Post generated with theme: ${theme}`);
  });

  it('should generate and post a daily post', async () => {
    const response = await request(app).get(dailyPostUrl);
    expect(response.statusCode).toBe(200);
    expect(response.text).toBe('Daily post generated and published!');
  });
});
