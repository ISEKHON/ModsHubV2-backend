import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { emitToUser } from '../lib/socket.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check whether a role string is privileged (admin or owner).
 */
const isPrivileged = (role?: string): boolean =>
  role === 'admin' || role === 'owner';

// =============================================================================
// Zod Schemas
// =============================================================================

const listQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, parseInt(v || '1', 10))),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '10', 10)))),
  sort: z
    .enum(['newest', 'oldest', 'highest', 'lowest'])
    .optional()
    .default('newest'),
});

const createReviewSchema = z.object({
  rating: z
    .number()
    .int('Rating must be a whole number')
    .min(1, 'Rating must be at least 1')
    .max(5, 'Rating must be at most 5'),
  content: z
    .string()
    .min(5, 'Review must be at least 5 characters')
    .max(2000, 'Review must be at most 2000 characters'),
});

const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  content: z.string().min(5).max(2000).optional(),
});

// =============================================================================
// Shared Prisma includes
// =============================================================================

/** Include public user profile fields on review queries. */
const userInclude = {
  user: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      isVerified: true,
    },
  },
} as const;

/** Sort mapping from user-facing name → Prisma orderBy clause. */
const sortMap: Record<string, object> = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  highest: { rating: 'desc' },
  lowest: { rating: 'asc' },
};

// =============================================================================
// Router
// =============================================================================

const router = Router();

function getParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /mod/:modId  — List reviews for a mod (public, optionalAuth).
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/mod/:modId',
  optionalAuth,
  validate({ query: listQuerySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const modId = getParam(req.params.modId);
      if (!modId) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const { page, limit, sort } =
        (res.locals.validated?.query ?? req.query) as z.infer<typeof listQuerySchema>;

      // Verify the mod exists
      const mod = await prisma.mod.findUnique({ where: { id: modId } });
      if (!mod || mod.status === 'deleted') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      const skip = (page - 1) * limit;
      const orderBy = sortMap[sort ?? 'newest'];

      const where = { modId };

      const [reviews, total] = await Promise.all([
        prisma.review.findMany({
          where,
          include: userInclude,
          orderBy,
          skip,
          take: limit,
        }),
        prisma.review.count({ where }),
      ]);

      // Compute average rating across all reviews for this mod
      const ratingAgg = await prisma.review.aggregate({
        where: { modId },
        _avg: { rating: true },
      });
      const avgRating = Math.round((ratingAgg._avg.rating ?? 0) * 10) / 10;

      res.json({
        reviews,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        avgRating,
      });
    } catch (err) {
      console.error('[GET /reviews/mod/:modId]', err);
      res.status(500).json({ error: 'Failed to fetch reviews' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /mod/:modId  — Post a review for a mod.
//
// - One review per user per mod (Prisma unique constraint).
// - Cannot review your own mod.
// - Emits a notification to the mod author.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/mod/:modId',
  requireAuth,
  validate({ body: createReviewSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const modId = getParam(req.params.modId);
      if (!modId) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const { rating, content } = req.body as z.infer<typeof createReviewSchema>;

      // Verify the mod exists and is published
      const mod = await prisma.mod.findUnique({ where: { id: modId } });
      if (!mod || mod.status !== 'published') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      // Prevent self-reviews
      if (mod.authorId === user.id) {
        res.status(403).json({ error: 'You cannot review your own mod' });
        return;
      }

      // Check for existing review (Prisma unique constraint fallback)
      const existing = await prisma.review.findUnique({
        where: { modId_userId: { modId, userId: user.id } },
      });
      if (existing) {
        res.status(409).json({ error: 'You have already reviewed this mod' });
        return;
      }

      // Create the review
      const review = await prisma.review.create({
        data: {
          modId,
          userId: user.id,
          rating,
          content,
        },
        include: userInclude,
      });

      // Log the review activity
      await prisma.activityLog.create({
        data: {
          type: 'review',
          message: `${user.username} reviewed "${mod.title}" — ${rating}★`,
          userId: user.id,
          metadata: { modId, reviewId: review.id },
        },
      });

      // ── Notify mod author ──────────────────────────────────────────────
      const notification = await prisma.notification.create({
        data: {
          userId: mod.authorId,
          type: 'review',
          title: 'New Review',
          message: `${user.username} rated your mod "${mod.title}" ${rating}★`,
          link: `/mods/${modId}`,
        },
      });

      emitToUser(mod.authorId, 'notification', notification);

      res.status(201).json(review);
    } catch (err: any) {
      // Handle Prisma unique-constraint violation (race condition safety net)
      if (err?.code === 'P2002') {
        res.status(409).json({ error: 'You have already reviewed this mod' });
        return;
      }
      console.error('[POST /reviews/mod/:modId]', err);
      res.status(500).json({ error: 'Failed to create review' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id  — Edit own review.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  '/:id',
  requireAuth,
  validate({ body: updateReviewSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Review ID is required' });
        return;
      }
      const data = req.body as z.infer<typeof updateReviewSchema>;

      const existing = await prisma.review.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Review not found' });
        return;
      }

      // Only the review author can edit
      if (existing.userId !== user.id) {
        res.status(403).json({ error: 'You can only edit your own reviews' });
        return;
      }

      const review = await prisma.review.update({
        where: { id },
        data,
        include: userInclude,
      });

      res.json(review);
    } catch (err) {
      console.error('[PUT /reviews/:id]', err);
      res.status(500).json({ error: 'Failed to update review' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id  — Delete own review (or admin/owner can delete any).
// ─────────────────────────────────────────────────────────────────────────────

router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Review ID is required' });
        return;
      }

      const existing = await prisma.review.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Review not found' });
        return;
      }

      // Ownership or admin/owner check
      if (existing.userId !== user.id && !isPrivileged(user.role)) {
        res.status(403).json({ error: 'You can only delete your own reviews' });
        return;
      }

      await prisma.review.delete({ where: { id } });

      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /reviews/:id]', err);
      res.status(500).json({ error: 'Failed to delete review' });
    }
  },
);

export default router;
