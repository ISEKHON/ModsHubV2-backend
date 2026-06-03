import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { setupSocketIO } from './lib/socket.js';
import path from 'path';

// ---------------------------------------------------------------------------
// App & server bootstrap
// ---------------------------------------------------------------------------

const app = express();
const httpServer = createServer(app);
const io = setupSocketIO(httpServer);

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  }),
);

app.use(express.json({ limit: '10mb' }));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import modsRouter from './routes/mods.js';
import chatsRouter from './routes/chats.js';
import notificationsRouter from './routes/notifications.js';
import reviewsRouter from './routes/reviews.js';
import likesRouter from './routes/likes.js';
import reportsRouter from './routes/reports.js';
import activityRouter from './routes/activity.js';

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/mods', modsRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/likes', likesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/activity', activityRouter);

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[ERROR]', err.message);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: err.message || 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '4000', 10);

httpServer.listen(PORT, () => {
  console.log(`🚀 ModsHub Backend running on port ${PORT}`);
});

export { app, httpServer, io };
