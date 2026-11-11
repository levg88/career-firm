import express from 'express';

import { postGeneration } from '../services/postGeneration';

const router = express.Router();

router.post('/generate', async (req, res) => {
  const { theme, topic } = req.body || {};
  const selected = theme || topic || 'General';
  try {
    await postGeneration.generateAsync(selected);
  } catch {
    postGeneration.generate(selected);
  }
  res.send(`Post generated with theme: ${selected}`);
});

router.get('/daily', async (req, res) => {
  try {
    await postGeneration.dailyAsync();
  } catch {
    postGeneration.daily();
  }
  res.send('Daily post generated and published!');
});

export default router;