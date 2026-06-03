import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  hashPassword,
  comparePassword,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip `passwordHash` from a user object before sending it to the client.
 */
const sanitizeUser = (user: any) => {
  const { passwordHash, ...safe } = user;
  return safe;
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must be at most 20 characters')
    .regex(
      /^[a-z0-9_]+$/,
      'Username must be lowercase alphanumeric with underscores only',
    ),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  displayName: z
    .string()
    .min(2, 'Display name must be at least 2 characters')
    .max(30, 'Display name must be at most 30 characters'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ---------------------------------------------------------------------------
// POST /register
// ---------------------------------------------------------------------------

router.post(
  '/register',
  validate({ body: registerSchema }),
  async (req, res, next) => {
    try {
      const { username, email, password, displayName } = req.body;

      // Check uniqueness of username and email in parallel
      const [existingUsername, existingEmail] = await Promise.all([
        prisma.user.findUnique({ where: { username } }),
        prisma.user.findUnique({ where: { email } }),
      ]);

      if (existingUsername) {
        res.status(409).json({ error: 'Username is already taken' });
        return;
      }

      if (existingEmail) {
        res.status(409).json({ error: 'Email is already registered' });
        return;
      }

      // Hash the password and create the user
      const passwordHash = await hashPassword(password);

      const user = await prisma.user.create({
        data: {
          username,
          email,
          passwordHash,
          displayName,
          role: 'member',
        },
      });

      // Log registration activity
      await prisma.activityLog.create({
        data: {
          type: 'register',
          message: `User ${username} registered`,
          userId: user.id,
        },
      });

      // Sign tokens
      const accessToken = signAccessToken(user.id);
      const refreshToken = signRefreshToken(user.id);

      res.status(201).json({
        user: sanitizeUser(user),
        accessToken,
        refreshToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

router.post(
  '/login',
  validate({ body: loginSchema }),
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });

      if (!user) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      // Verify password
      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      // Check if user is banned
      if (user.status === 'banned') {
        res.status(403).json({
          error: 'Account banned',
          reason: user.banReason,
        });
        return;
      }

      // Sign tokens
      const accessToken = signAccessToken(user.id);
      const refreshToken = signRefreshToken(user.id);

      res.json({
        user: sanitizeUser(user),
        accessToken,
        refreshToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /refresh
// ---------------------------------------------------------------------------

router.post(
  '/refresh',
  validate({ body: refreshSchema }),
  async (req, res, next) => {
    try {
      const { refreshToken } = req.body;

      const { userId } = verifyRefreshToken(refreshToken);

      // Issue a fresh access token
      const accessToken = signAccessToken(userId);

      res.json({ accessToken });
    } catch {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /logout  (stateless JWT — client clears tokens)
// ---------------------------------------------------------------------------

router.post('/logout', (_req, res) => {
  res.json({ success: true });
});

export default router;
