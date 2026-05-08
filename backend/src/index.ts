import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { json } from 'express';
import swaggerUi from 'swagger-ui-express';
import path from 'path';

import { initializeDatabase, AppDataSource } from './database/dataSource';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { authenticateToken } from './middleware/auth';
import { Auditor, auditMiddleware } from './auth';
import { TypeOrmAuditWriter, mockAuditWriter } from './auth/writers';

// Route imports
import scanRouter from './routes/scan';
import machineRouter from './routes/machines';
import groupRouter from './routes/groups';
import exportRouter from './routes/export';
import controlRouter from './routes/controls';
import auditRouter from './routes/audit';
import healthRouter from './routes/health';
import stigsRouter from './routes/stigs';
import poamsRouter from './routes/poams';
import notificationsRouter from './routes/notifications';
import remediationRouter from './routes/remediation';
import complianceHistoryRouter from './routes/compliance-history';
import usersRouter from './routes/users';
import rmfRouter from './routes/rmf';

import { startStigUpdateScheduler } from './stigs/stigUpdateScheduler';

// ─── Production safety: forbid MOCK_MODE in prod (Audit #1) ───────────────
if (process.env.NODE_ENV === 'production' && process.env.MOCK_MODE === 'true') {
  // eslint-disable-next-line no-console
  console.error('FATAL: MOCK_MODE=true is forbidden when NODE_ENV=production');
  process.exit(1);
}

// Application Insights (optional, only if instrumentation key is set)
if (process.env.APPINSIGHTS_INSTRUMENTATIONKEY) {
  const appInsights = require('applicationinsights');
  appInsights.setup(process.env.APPINSIGHTS_INSTRUMENTATIONKEY)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true)
    .start();
}

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Security middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(compression());
app.use(json({ limit: '1mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));

// Rate limiting — global low-rate limiter applied to ALL routes (Audit #17),
// with a higher per-API-route limiter on /api/* for authenticated traffic.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ─── Public routes (no auth required) ──────────────────────────────────────
app.use('/health', healthRouter);

// ─── Protected routes (JWT required for all /api/* below) ───────────────────
app.use('/api', authenticateToken);

// ─── Audit + correlation ID (Principle II / FR-003) ────────────────────────
// Wire the canonical Auditor onto every authenticated request so route
// handlers can call `req.audit.record(...)`. In MOCK_MODE we use the in-memory
// writer; in real mode we use the TypeORM-backed writer.
const auditor = new Auditor(
  process.env.MOCK_MODE === 'true'
    ? mockAuditWriter
    : new TypeOrmAuditWriter(AppDataSource),
  {
    fallbackLog: (p) =>
      logger.error('audit_write_failed', {
        action: p.action,
        correlationId: p.correlationId,
        err: p.error instanceof Error ? p.error.message : p.error,
      }),
  },
);
app.use('/api', auditMiddleware({ auditor }));

// Swagger / OpenAPI — mounted after auth so it requires a valid token
try {
  const YAML = require('yamljs');
  const swaggerDocument = YAML.load(path.join(__dirname, '../openapi.yaml'));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} catch {
  logger.warn('openapi.yaml not found — Swagger UI will not be available');
}
app.use('/api/scan', scanRouter);
app.use('/api/machines', machineRouter);
app.use('/api/groups', groupRouter);
app.use('/api/export', exportRouter);
app.use('/api/controls', controlRouter);
app.use('/api/audit', auditRouter);
app.use('/api/stigs', stigsRouter);
app.use('/api/poams', poamsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/remediation', remediationRouter);
app.use('/api/compliance-history', complianceHistoryRouter);
app.use('/api/users', usersRouter);
app.use('/api/rmf', rmfRouter);

// ─── Error handling ──────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await initializeDatabase();
    logger.info('Database connection established');

    app.listen(PORT, () => {
      logger.info(`Backend listening on port ${PORT}`);
      logger.info(`Swagger docs available at http://localhost:${PORT}/api/docs`);
    });

    // Start STIG update scheduler (skip in mock mode — no DB)
    if (process.env.MOCK_MODE !== 'true') {
      startStigUpdateScheduler(AppDataSource);
    }
  } catch (err) {
    logger.error('Failed to start application', err);
    process.exit(1);
  }
}

// Only auto-bootstrap when invoked directly (Audit #4) — prevents tests that
// import the app from spinning up a real listener / DB connection.
if (require.main === module) {
  bootstrap();
}

export default app;
