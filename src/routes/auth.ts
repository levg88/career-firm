import express from 'express';

import { LinkedInService } from '../services/linkedin';

const router = express.Router();

router.get('/linkedin', (req, res) => {
  const linkedInService = new LinkedInService();
  const authUrl = linkedInService.getAuthorizationUrl();
  res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (code) {
    try {
      const linkedInService = new LinkedInService();
      await linkedInService.getAccessToken(code as string);
      res.send('Authorization successful!');
    } catch (err) {
      res.status(500).send('Authorization failed');
    }
  } else {
    res.status(400).send('Authorization code missing');
  }
});

export default router;