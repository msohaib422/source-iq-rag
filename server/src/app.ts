/** Express application factory (kept separate from the server bootstrap for testability). */
import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env, isTest } from './config/env.js';
import { getContext, type AppContext } from './context.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { withContext } from './middleware/index.js';
import { authRouter } from './routes/auth.js';
import { chatRouter } from './routes/chat.js';
import { chunksRouter } from './routes/chunks.js';
import { documentsRouter } from './routes/documents.js';
import { healthRouter } from './routes/health.js';

export function createApp(context?: AppContext): Express {
  const app = express();
  // The container every request in this app will use.
  app.locals.context = context ?? getContext();

  app.disable('x-powered-by');
  // Required for correct client IPs and rate limiting behind a proxy.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON and file uploads only; CSP is enforced by the
      // client build, so the default (which assumes a browser document) is
      // not appropriate here.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const origins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: origins.length ? origins : false,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['Content-Disposition'],
    }),
  );

  app.use(compression());
  // Chat streaming must not be buffered by compression.
  app.use(compression({ filter: (req, res) => (res.getHeader('Content-Type') === 'text/event-stream' ? false : compression.filter(req, res)) }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  if (!isTest) {
    app.use((req, _res, next) => {
      const started = Date.now();
      next();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_res as any).on('finish', () => {
        if (req.originalUrl === '/api/health') return;
        console.log(`${req.method} ${req.originalUrl} -> ${_res.statusCode} (${Date.now() - started}ms)`);
      });
    });
  }

  app.use(withContext);

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/chunks', chunksRouter);
  app.use('/api/chat', chatRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}