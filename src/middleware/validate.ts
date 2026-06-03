import type { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns Express middleware that validates `req.body`, `req.params`, and/or
 * `req.query` against the provided Zod schemas. On validation failure it
 * responds with a 400 containing structured error details.
 *
 * @example
 * ```ts
 * router.post(
 *   '/mods',
 *   validate({ body: createModSchema }),
 *   createModHandler,
 * );
 * ```
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const validated: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      } = res.locals.validated ?? {};

      if (schemas.body) {
        const parsedBody = schemas.body.parse(req.body);
        req.body = parsedBody;
        validated.body = parsedBody;
      }

      if (schemas.params) {
        const parsedParams = schemas.params.parse(req.params) as typeof req.params;
        Object.assign(req.params, parsedParams);
        validated.params = parsedParams;
      }

      if (schemas.query) {
        const parsedQuery = schemas.query.parse(req.query) as typeof req.query;
        validated.query = parsedQuery;
      }

      res.locals.validated = validated;

      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const formatted = err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        }));

        res.status(400).json({
          error: 'Validation failed',
          details: formatted,
        });
        return;
      }

      // Re-throw unexpected errors for the global handler
      next(err);
    }
  };
}
