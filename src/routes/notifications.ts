import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

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
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '20', 10)))),
});

// =============================================================================
// Router
// =============================================================================

const router = Router();

function getParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — List notifications for the authenticated user (newest first).
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  validate({ query: listQuerySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const { page, limit } =
        (res.locals.validated?.query ?? req.query) as z.infer<typeof listQuerySchema>;

      const skip = (page - 1) * limit;

      const [notifications, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.notification.count({ where: { userId: user.id } }),
        prisma.notification.count({ where: { userId: user.id, isRead: false } }),
      ]);

      res.json({
        notifications,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        unreadCount,
      });
    } catch (err) {
      console.error('[GET /notifications]', err);
      res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /unread-count  — Quick count of unread notifications.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/unread-count',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;

      const count = await prisma.notification.count({
        where: { userId: user.id, isRead: false },
      });

      res.json({ count });
    } catch (err) {
      console.error('[GET /notifications/unread-count]', err);
      res.status(500).json({ error: 'Failed to fetch unread count' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /read-all  — Mark ALL of the user's notifications as read.
//
// NOTE: This route is defined BEFORE /:id/read so Express doesn't treat
// "read-all" as a dynamic :id parameter.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  '/read-all',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;

      const result = await prisma.notification.updateMany({
        where: { userId: user.id, isRead: false },
        data: { isRead: true },
      });

      res.json({ count: result.count });
    } catch (err) {
      console.error('[PUT /notifications/read-all]', err);
      res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id/read  — Mark a single notification as read.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  '/:id/read',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Notification ID is required' });
        return;
      }

      // Fetch the notification and verify ownership
      const notification = await prisma.notification.findUnique({
        where: { id },
      });

      if (!notification) {
        res.status(404).json({ error: 'Notification not found' });
        return;
      }

      if (notification.userId !== user.id) {
        res.status(403).json({ error: 'You can only manage your own notifications' });
        return;
      }

      await prisma.notification.update({
        where: { id },
        data: { isRead: true },
      });

      res.json({ success: true });
    } catch (err) {
      console.error('[PUT /notifications/:id/read]', err);
      res.status(500).json({ error: 'Failed to mark notification as read' });
    }
  },
);

export default router;
