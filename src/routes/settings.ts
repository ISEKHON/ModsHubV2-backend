import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

// =============================================================================
// Zod Schemas
// =============================================================================

const updateSettingsSchema = z.object({
  maintenanceMode: z.boolean().optional(),
  registrationOpen: z.boolean().optional(),
  modApprovalRequired: z.boolean().optional(),
  announcement: z.string().max(500).optional(),
  announcementActive: z.boolean().optional(),
});

// =============================================================================
// Router
// =============================================================================

const router = Router();

/**
 * GET /public — Get public site settings (no auth required)
 */
router.get(
  '/public',
  async (_req: Request, res: Response): Promise<void> => {
    try {
      let settings = await prisma.siteSettings.findFirst();

      if (!settings) {
        settings = await prisma.siteSettings.create({
          data: {
            maintenanceMode: false,
            registrationOpen: true,
            modApprovalRequired: false,
            announcement: '',
            announcementActive: false,
          },
        });
      }

      // Only send public-facing settings
      res.json({
        maintenanceMode: settings.maintenanceMode,
        registrationOpen: settings.registrationOpen,
        announcement: settings.announcement,
        announcementActive: settings.announcementActive,
      });
    } catch (err) {
      console.error('[GET /settings/public]', err);
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  },
);

// All other routes require authentication
router.use(requireAuth);

/**
 * GET / — Get current site settings (admin/owner only)
 */
router.get(
  '/',
  requireRole('admin', 'owner'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      // Get settings from database (we'll store in a single-row table)
      let settings = await prisma.siteSettings.findFirst();

      // Create default settings if none exist
      if (!settings) {
        settings = await prisma.siteSettings.create({
          data: {
            maintenanceMode: false,
            registrationOpen: true,
            modApprovalRequired: false,
            announcement: '',
            announcementActive: false,
          },
        });
      }

      res.json(settings);
    } catch (err) {
      console.error('[GET /settings]', err);
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  },
);

/**
 * PUT / — Update site settings (admin/owner only)
 */
router.put(
  '/',
  requireRole('admin', 'owner'),
  validate({ body: updateSettingsSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const data = req.body as z.infer<typeof updateSettingsSchema>;

      // Get or create settings
      let settings = await prisma.siteSettings.findFirst();

      if (!settings) {
        settings = await prisma.siteSettings.create({
          data: {
            maintenanceMode: false,
            registrationOpen: true,
            modApprovalRequired: false,
            announcement: '',
            announcementActive: false,
            ...data,
          },
        });
      } else {
        settings = await prisma.siteSettings.update({
          where: { id: settings.id },
          data,
        });
      }

      res.json(settings);
    } catch (err) {
      console.error('[PUT /settings]', err);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  },
);

/**
 * POST /export/mods — Export all mods data as JSON
 */
router.post(
  '/export/mods',
  requireRole('admin', 'owner'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const mods = await prisma.mod.findMany({
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
            },
          },
        },
      });

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="mods-export-${Date.now()}.json"`);
      res.json(mods);
    } catch (err) {
      console.error('[POST /settings/export/mods]', err);
      res.status(500).json({ error: 'Failed to export mods' });
    }
  },
);

/**
 * POST /export/users — Export all users data as JSON
 */
router.post(
  '/export/users',
  requireRole('admin', 'owner'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          role: true,
          isVerified: true,
          isBanned: true,
          createdAt: true,
        },
      });

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="users-export-${Date.now()}.json"`);
      res.json(users);
    } catch (err) {
      console.error('[POST /settings/export/users]', err);
      res.status(500).json({ error: 'Failed to export users' });
    }
  },
);

/**
 * POST /clear-activity — Clear old activity logs
 */
router.post(
  '/clear-activity',
  requireRole('admin', 'owner'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const result = await prisma.activityLog.deleteMany({
        where: {
          createdAt: {
            lt: thirtyDaysAgo,
          },
        },
      });

      res.json({ deleted: result.count });
    } catch (err) {
      console.error('[POST /settings/clear-activity]', err);
      res.status(500).json({ error: 'Failed to clear activity logs' });
    }
  },
);

export default router;
