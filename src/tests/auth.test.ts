import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../server';

const authUrl = '/auth/linkedin';
const callbackUrl = '/auth/callback';

describe('LinkedIn OAuth', () => {
  it('should redirect to LinkedIn for authorization', async () => {
    const response = await request(app).get(authUrl);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://www.linkedin.com/oauth/v2/authorization');
  });

  it('should handle LinkedIn callback and store access token', async () => {
    const code = 'dummy_code';
    const response = await request(app).get(`${callbackUrl}?code=${code}`);
    expect(response.statusCode).toBe(200);
    expect(response.text).toBe('Authorization successful!');
  });
});
