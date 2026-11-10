
import express from 'express';
import authRoutes from './routes/auth';
import postsRoutes from './routes/posts';

export default function server(app: express.Application) {
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/posts', postsRoutes);
}
