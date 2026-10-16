/** Central error handler + 404 fallthrough. Converts anything thrown into clean JSON. */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { LlmConfigurationError } from '../services/llm/types.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.originalUrl}.` },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred.';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof LlmConfigurationError) {
    status = 503;
    code = 'LLM_UNAVAILABLE';
    message = err.message;
  } else if (isMulterError(err)) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = 'UPLOAD_ERROR';
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is too large. Maximum size is ${err.field ?? 'configured'} limit.`
        : err.message;
  } else if (isDuplicateKeyError(err)) {
    status = 409;
    code = 'CONFLICT';
    message = 'That resource already exists.';
  } else if (isStoreUnavailable(err)) {
    // A datastore outage is an expected operational state, not an app bug:
    // answer with a clean 503 and never leak driver internals to the client.
    status = 503;
    code = 'STORE_UNAVAILABLE';
    message = 'The datastore is temporarily unavailable. Please retry shortly.';
  } else if (err instanceof SyntaxError && 'body' in err) {
    status = 400;
    code = 'MALFORMED_JSON';
    message = 'Request body is not valid JSON.';
  }
  // Any other error stays a generic 500: arbitrary `Error.message` text can
  // embed driver or framework internals, so it never reaches the client. The
  // full error (including the stack) is logged above for 5xx responses.

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  // Never expose stack traces or driver internals to callers: the response is
  // purely a client-facing envelope. Full traces for 5xx are logged above.
  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

interface MulterLikeError extends Error {
  code?: string;
  field?: string;
}

function isMulterError(err: unknown): err is MulterLikeError {
  return err instanceof Error && typeof (err as MulterLikeError).code === 'string' && 'field' in err;
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { code?: number }).code === 11000 || (err as { code?: string }).code === 'E11000')
  );
}

/** MongoDB/Mongoose connectivity failures (cluster down, no initial connect, network dropped). */
function isStoreUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    [
      'MongoServerSelectionError',
      'MongooseServerSelectionError',
      'MongoNetworkError',
      'MongoNetworkTimeoutError',
      'MongoNotConnectedError',
      'MongoTopologyClosedError',
      'MongoPoolClosedError',
    ].includes(err.name)
  ) {
    return true;
  }
  // `bufferCommands: false` surfaces operations on a disconnected client as an
  // immediate Mongoose "before initial connection is complete" error; older
  // drivers still report the timeouts below.
  return /buffering timed out|server selection timed out|before initial connection is complete/i.test(err.message);
}