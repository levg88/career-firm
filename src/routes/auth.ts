
import express from 'express';
import { LinkedInService } from '../services/linkedin';

const router = express.Router();
const linkedInService = new LinkedInService();

router.get('/linkedin', (req, res) => {
  const authUrl = linkedInService.getAuthorizationUrl();
  res.redirect(authUrl);
});

router.get('/callback', (req, res) => {
  const { code } = req.query;
  if (code) {
    linkedInService.getAccessToken(code as string).then(token => {
      res.send('Authorization successful!');
    }).catch(err => {
      res.status(500).send('Authorization failed');
    });
  } else {
    res.status(400).send('Authorization code missing');
  }
});

export default router;
