import express from 'express';

const router = express.Router();

router.post('/generate', (req, res) => {
  const { theme } = req.body;
  // Generate a post with the specified theme
  res.send(`Post generated with theme: ${theme}`);
});

router.get('/daily', (req, res) => {
  // Generate and post a daily post
  res.send('Daily post generated and published!');
});

export default router;
