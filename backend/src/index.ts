import 'reflect-metadata';
import dotenv from 'dotenv';
// `quiet` suppresses the banner dotenv 17 prints on load, which would otherwise
// be the first line of every container's stdout and confuse log ingestion.
dotenv.config({ quiet: true });

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
import { authenticate } from './middleware/authn';
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
import hierarchyRouter from './routes/hierarchy';
import emassRouter from './routes/emass';
import vulnerabilitiesRouter from './routes/vulnerabilities';
import meRouter from './routes/me';
import collectionsRouter from './routes/collections';
import poolsRouter from './routes/pools';
import updatesRouter from './routes/updates';
import powerScheduleRouter from './routes/powerSchedule';

import { startStigUpdateScheduler } from './stigs/stigUpdateScheduler';
import { startScanScheduler } from './scanning/scanScheduler';

// ─── Production safety: MOCK_MODE needs an explicit opt-in (Audit #1) ─────
// Demo deployments legitimately pair MOCK_MODE with NODE_ENV=production, so the
// guard demands a second deliberate flag rather than refusing outright — a
// stray MOCK_MODE=true still cannot pass real-looking data off as genuine.
if (process.env.NODE_ENV === 'production' && process.env.MOCK_MODE === 'true') {
  if (process.env.ALLOW_MOCK_IN_PRODUCTION !== 'true') {
    // eslint-disable-next-line no-console
    console.error('FATAL: MOCK_MODE=true requires ALLOW_MOCK_IN_PRODUCTION=true when NODE_ENV=production');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.warn('WARNING: demo mode is on — every compliance figure this API returns is fabricated and must not be used for an authorization decision');
}

const app = express();
const PORT = process.env.PORT || 3001;

app.disable('x-powered-by');

// Trust the first reverse proxy hop (App Service front-end / nginx in the
// frontend container). Without this, req.ip is the proxy address, which makes
// express-rate-limit a single global bucket and corrupts audit-log client IPs.
app.set('trust proxy', 1);

// ─── Security middleware ────────────────────────────────────────────────────
app.use(helmet({
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The API serves JSON only, so no inline script/style is ever needed here.
      // Swagger UI, which does require them, gets a relaxed policy on its own route.
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
}));
// CORS origin is locked to FRONTEND_URL. In production it MUST be https so that
// credentialed (cookie/authorization) cross-origin requests cannot be sent to a
// plaintext or misconfigured origin.
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
if (process.env.NODE_ENV === 'production' && !frontendUrl.startsWith('https://')) {
  // eslint-disable-next-line no-console
  console.error('FATAL: FRONTEND_URL must be an https:// URL when NODE_ENV=production');
  process.exit(1);
}
app.use(cors({
  origin: frontendUrl,
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

const sensitiveWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests. Please retry later.' },
});
app.use('/api/remediation', sensitiveWriteLimiter);
app.use('/api/users', sensitiveWriteLimiter);
app.use('/api/notifications', sensitiveWriteLimiter);

// ─── Public routes (no auth required) ──────────────────────────────────────
app.use('/health', healthRouter);

// ─── Protected routes (JWT required for all /api/* below) ───────────────────
app.use('/api', authenticate);

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
  // Required lazily so a missing yamljs degrades to "no /api/docs" instead of failing boot.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const YAML = require('yamljs');
  const swaggerDocument = YAML.load(path.join(__dirname, '../openapi.yaml'));
  // Swagger UI ships inline bootstrap script/styles, so it needs a relaxed CSP.
  // Scope that relaxation to this route only, keeping the strict policy global.
  const swaggerCsp = helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  });
  app.use('/api/docs', swaggerCsp, swaggerUi.serve, swaggerUi.setup(swaggerDocument));
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
app.use('/api/hierarchy', hierarchyRouter);
app.use('/api/emass', emassRouter);
app.use('/api/vulnerabilities', vulnerabilitiesRouter);
app.use('/api/me', meRouter);
app.use('/api/collections', collectionsRouter);
app.use('/api/pools', poolsRouter);
app.use('/api/updates', updatesRouter);
app.use('/api/power-schedule', powerScheduleRouter);

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
      // Automated compliance scans (opt-in via SCAN_SCHEDULE_ENABLED=true)
      startScanScheduler();
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
