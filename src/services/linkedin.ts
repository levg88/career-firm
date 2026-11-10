
import { OAuth2Client } from 'google-auth-library';

class LinkedInService {
  private client: OAuth2Client;

  constructor() {
    this.client = new OAuth2Client({
      clientId: 'YOUR_CLIENT_ID',
      clientSecret: 'YOUR_CLIENT_SECRET',
      redirectUri: 'http://localhost:3000/auth/callback'
    });
  }

  getAuthorizationUrl(): string {
    return this.client.generateAuthUrl({
      access_type: 'offline',
      scope: ['r_liteprofile', 'r_emailaddress', 'w_member_social']
    });
  }

  async getAccessToken(code: string): Promise<string> {
    const { tokens } = await this.client.getToken(code);
    return tokens.access_token as string;
  }
}

export default LinkedInService;
