import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { getContext, type AppContext } from '../context.js';
import { unauthorized, AppError } from '../utils/errors.js';
import { bearerToken, verifyToken } from '../services/auth.js';
import { getOrCreatePublicWorkspaceUser } from '../services/accounts.js';
import type { UserRecord } from '../types/domain.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: AppContext;
      user?: UserRecord;
    }
  }
}

/** Attach the container to every request. */
export function withContext(req: Request, _res: Response, next: NextFunction): void {
  // Bind the container to the *app instance* rather than a module global, so two
  // isolated app instances (tests, or one process per tenant) never share state.
  // `createApp(context)` is the seam that installs it.
  const ctx = (req.app.locals.context as AppContext | undefined) ?? getContext();
  req.ctx = ctx;
  next();
}

/**
 * Authentication rules.
 *
 * Only the admin can authenticate: tokens are accepted exclusively for accounts
 * with the `admin` role. Regular users never sign in — requests without a token
 * are attached to the shared public workspace account (see services/accounts.ts),
 * so the existing per-user data scoping keeps working anonymously.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  authenticateAdmin(req, next);
}

/**
 * Admin token when one is present, otherwise the shared public workspace user.
 * Used by every user-facing route so regular users need no account.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  // A request that carries credentials must present a valid admin token; a
  // broken/expired token is an error rather than a silent downgrade.
  if (req.headers.authorization) {
    authenticateAdmin(req, next);
    return;
  }

  getOrCreatePublicWorkspaceUser(req.ctx.store)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(next);
}

function authenticateAdmin(req: Request, next: NextFunction): void {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    next(unauthorized('Missing Authorization: Bearer <token> header.'));
    return;
  }
  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    next(
      (err instanceof Error && err.name === 'TokenExpiredError'
        ? unauthorized('Your session has expired. Please sign in again.')
        : unauthorized('Invalid authentication token.')),
    );
    return;
  }

  // Re-read the user so deleted accounts cannot keep using stale tokens.
  req.ctx.store
    .findUserById(payload.sub)
    .then((user) => {
      if (!user) {
        next(unauthorized('Account no longer exists.'));
        return;
      }
      if (user.role !== 'admin') {
        next(unauthorized('This account is not authorized to sign in.'));
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
}

export function currentUser(req: Request): UserRecord {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * Validate `req[source]` against a Zod schema, replacing it with the parsed
 * (coerced, stripped) value so handlers only ever see clean input.
 */
/**
 * Zod can report several issues for the same field (e.g. a too-short password
 * fails both `.min(8)` and a `.refine()` composition check). Naively mapping
 * issues to a `path -> message` record would silently keep only the last one,
 * which is arbitrary. We keep the *first* issue per path — it is the most
 * fundamental complaint — so the message a user sees is deterministic.
 */
function dedupeIssues(error: ZodError): Array<{ path: string; message: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; message: string }> = [];
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path: issue.path.join('.'), message: issue.message });
  }
  return out;
}

export function validate<T>(schema: ZodType<T>, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(
        new AppError(422, 'VALIDATION_ERROR', 'Request validation failed.', {
          issues: dedupeIssues(result.error),
        }),
      );
      return;
    }
    if (source === 'query') {
      // Express 5 exposes req.query as a getter; assign via defineProperty.
      Object.defineProperty(req, 'query', { value: result.data, configurable: true, writable: true });
    } else {
      req[source] = result.data as never;
    }
    next();
  };
}

export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

export function zodErrorToAppError(err: unknown): AppError | null {
  if (err instanceof ZodError) {
    return new AppError(422, 'VALIDATION_ERROR', 'Request validation failed.', {
      issues: dedupeIssues(err),
    });
  }
  return null;
}