import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  if (status >= 500) {
    logger.error(`[${err.code || 'ERROR'}] ${message}`, { stack: err.stack });
  } else {
    logger.warn(`[${err.code || 'WARN'}] ${message}`);
  }

  // For server-side (5xx) errors, never echo the raw error message to the
  // client in production — it can leak DB/driver internals or stack traces.
  // Client-side (4xx) messages are intentional and safe to return.
  const isProd = process.env.NODE_ENV === 'production';
  const clientMessage = status >= 500 && isProd ? 'Internal Server Error' : message;

  res.status(status).json({
    error: err.code || 'INTERNAL_ERROR',
    message: clientMessage,
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
}

export function createError(
  message: string,
  statusCode = 500,
  code?: string,
): AppError {
  const err: AppError = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Send an error response from a route handler without leaking internal error
 * details to the client. Logs the real error (with context) server-side and
 * returns a generic message. Use this instead of
 * `res.status(500).json({ error: err.message })`.
 *
 * @param status HTTP status to return (default 500). Use 502 for upstream
 *   (eMASS/Defender/etc.) failures.
 * @param extra  Optional additional fields to merge into the JSON body
 *   (e.g. `{ configured: false }`).
 */
export function sendServerError(
  res: Response,
  context: string,
  err: unknown,
  status = 500,
  extra?: Record<string, unknown>,
): void {
  logger.error(context, err);
  const message = status === 502 ? 'Upstream service error' : 'Internal Server Error';
  res.status(status).json({ error: 'INTERNAL_ERROR', message, ...(extra ?? {}) });
}
