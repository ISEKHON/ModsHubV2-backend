import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// =============================================================================
// Zod Schemas
// =============================================================================

const paginationSchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, parseInt(v || '1', 10))),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '20', 10)))),
  type: z
    .enum([
      'download',
      'unlock',
      'register',
      'upload',
      'ban',
      'feature',
      'delete',
      'review',
      'chat',
      'like',
      'report',
    ])
    .optional(),
});

// =============================================================================
// Router
// =============================================================================

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES — require admin or owner role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/all — List all activity logs with pagination and filtering.
 *
 * Query params: page, limit, type
 * Includes user info if userId is present.
 */
router.get(
  '/admin/all',
  requireAuth,
  requireRole('admin', 'owner'),
  validate({ query: paginationSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { page, limit, type } =
        (res.locals.validated?.query ?? req.query) as z.infer<
          typeof paginationSchema
        >;

      // ── Build dynamic where clause ────────────────────────────────
      const where: Record<string, unknown> = {};
      if (type) where.type = type;

      const skip = (page - 1) * limit;

      const [activities, total] = await Promise.all([
        prisma.activityLog.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.activityLog.count({ where }),
      ]);

      res.json({
        activities,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[GET /activity/admin/all]', err);
      res.status(500).json({ error: 'Failed to fetch activity logs' });
    }
  },
);

/**
 * GET /admin/stats — Activity statistics (count by type).
 */
router.get(
  '/admin/stats',
  requireAuth,
  requireRole('admin', 'owner'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const [
        downloads,
        unlocks,
        registers,
        uploads,
        bans,
        features,
        deletes,
        reviews,
        chats,
        likes,
        reports,
        total,
      ] = await Promise.all([
        prisma.activityLog.count({ where: { type: 'download' } }),
        prisma.activityLog.count({ where: { type: 'unlock' } }),
        prisma.activityLog.count({ where: { type: 'register' } }),
        prisma.activityLog.count({ where: { type: 'upload' } }),
        prisma.activityLog.count({ where: { type: 'ban' } }),
        prisma.activityLog.count({ where: { type: 'feature' } }),
        prisma.activityLog.count({ where: { type: 'delete' } }),
        prisma.activityLog.count({ where: { type: 'review' } }),
        prisma.activityLog.count({ where: { type: 'chat' } }),
        prisma.activityLog.count({ where: { type: 'like' } }),
        prisma.activityLog.count({ where: { type: 'report' } }),
        prisma.activityLog.count(),
      ]);

      res.json({
        downloads,
        unlocks,
        registers,
        uploads,
        bans,
        features,
        deletes,
        reviews,
        chats,
        likes,
        reports,
        total,
      });
    } catch (err) {
      console.error('[GET /activity/admin/stats]', err);
      res.status(500).json({ error: 'Failed to fetch activity statistics' });
    }
  },
);

/**
 * DELETE /admin/:id — Hard-delete an activity log entry.
 */
router.delete(
  '/admin/:id',
  requireAuth,
  requireRole('admin', 'owner'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const rawId = req.params.id;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!id) {
        res.status(400).json({ error: 'Activity log ID is required' });
        return;
      }

      const existing = await prisma.activityLog.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Activity log not found' });
        return;
      }

      await prisma.activityLog.delete({ where: { id } });

      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /activity/admin/:id]', err);
      res.status(500).json({ error: 'Failed to delete activity log' });
    }
  },
);

export default router;
