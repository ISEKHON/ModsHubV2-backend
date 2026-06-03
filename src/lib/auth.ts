import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

/** JWT secret for short-lived access tokens */
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret';
/** JWT secret for long-lived refresh tokens (must differ from access secret) */
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';

// ---------------------------------------------------------------------------
// Password utilities
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using bcrypt with 12 salt rounds.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export interface TokenPayload {
  userId: string;
}

// ---------------------------------------------------------------------------
// Token signing
// ---------------------------------------------------------------------------

/**
 * Sign a short-lived access token (15 min).
 */
export function signAccessToken(userId: string): string {
  return jwt.sign({ userId } satisfies TokenPayload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

/**
 * Sign a long-lived refresh token (7 days).
 */
export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId } satisfies TokenPayload, JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verify an access token and return the decoded payload.
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError} on invalid/expired tokens
 */
export function verifyAccessToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload & TokenPayload;
  return { userId: decoded.userId };
}

/**
 * Verify a refresh token and return the decoded payload.
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError} on invalid/expired tokens
 */
export function verifyRefreshToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as jwt.JwtPayload & TokenPayload;
  return { userId: decoded.userId };
}
