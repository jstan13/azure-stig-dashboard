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
app.use(json({ limit: '10mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));

// Rate limiting
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

bootstrap();

export default app;
