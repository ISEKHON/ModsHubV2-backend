import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

// ---------------------------------------------------------------------------
// Extend Express Request to carry the authenticated user
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: string;
  status: 'active' | 'banned';
  avatarUrl: string | null;
}

declare global {
  namespace Express {
    interface Request {
      /** The authenticated user, or `null` when using `optionalAuth`. */
      user?: AuthUser | null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Bearer token from the Authorization header.
 */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

// ---------------------------------------------------------------------------
// Middleware: requireAuth
// ---------------------------------------------------------------------------

/**
 * Requires a valid JWT access token. Attaches the full user object to
 * `req.user`. Returns 401 if the token is missing/invalid and 403 if the
 * user is banned.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractToken(req);

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { userId } = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        avatarUrl: true,
      },
    });

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    if (user.status === 'banned') {
      res.status(403).json({ error: 'Account is banned' });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// Middleware: requireRole
// ---------------------------------------------------------------------------

/**
 * Checks that the authenticated user has one of the specified roles.
 * Must be used **after** `requireAuth`.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Middleware: optionalAuth
// ---------------------------------------------------------------------------

/**
 * Like `requireAuth` but doesn't fail when no token is provided — it just
 * sets `req.user` to `null`. Useful for routes that behave differently for
 * authenticated vs. anonymous users.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractToken(req);

    if (!token) {
      req.user = null;
      next();
      return;
    }

    const { userId } = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        avatarUrl: true,
      },
    });

    req.user = user ?? null;
    next();
  } catch {
    // Token invalid — treat as unauthenticated
    req.user = null;
    next();
  }
}
