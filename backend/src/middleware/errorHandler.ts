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

  res.status(status).json({
    error: err.code || 'INTERNAL_ERROR',
    message,
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
