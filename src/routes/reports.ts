import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { emitToAdmins } from '../lib/socket.js';
import { sendReportAlert } from '../lib/email.js';

// =============================================================================
// Zod Schemas
// =============================================================================

// ── Submit report body ──────────────────────────────────────────────────────

const submitReportSchema = z.object({
  reason: z.enum([
    'malware',
    'stolen_content',
    'broken_mod',
    'misleading_info',
    'copyright',
    'inappropriate',
    'other',
  ]),
  details: z
    .string()
    .max(1000, 'Details must be at most 1000 characters')
    .optional(),
});

// ── Admin update report body ────────────────────────────────────────────────

const updateReportSchema = z.object({
  status: z.enum(['investigating', 'resolved', 'dismissed']),
  adminNotes: z.string().optional(),
});

// ── Admin action body ───────────────────────────────────────────────────────

const reportActionSchema = z.object({
  action: z.enum(['resolve', 'dismiss', 'remove_mod', 'ban_reporter']),
});

// ── Admin browse query params ───────────────────────────────────────────────

const adminReportsQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, parseInt(v || '1', 10))),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '20', 10)))),
  status: z
    .enum(['open', 'investigating', 'resolved', 'dismissed'])
    .optional(),
  reason: z
    .enum([
      'malware',
      'stolen_content',
      'broken_mod',
      'misleading_info',
      'copyright',
      'inappropriate',
      'other',
    ])
    .optional(),
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
// AUTH-REQUIRED ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /mod/:modId — Submit a report for a mod.
 *
 * - Validates the mod exists and is published.
 * - Prevents self-reporting and duplicate active reports.
 * - Notifies all admin/owner users via DB notification, Socket.IO, and email.
 */
router.post(
  '/mod/:modId',
  requireAuth,
  validate({ body: submitReportSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const modId = getParam(req.params.modId);
      if (!modId) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const user = req.user!;
      const { reason, details } = req.body as z.infer<typeof submitReportSchema>;

      // ── Verify mod exists and is published ──────────────────────────
      const mod = await prisma.mod.findUnique({
        where: { id: modId },
        select: { id: true, title: true, status: true, authorId: true },
      });

      if (!mod || mod.status !== 'published') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      // ── Cannot report your own mod ──────────────────────────────────
      if (mod.authorId === user.id) {
        res.status(403).json({ error: 'You cannot report your own mod' });
        return;
      }

      // ── One active report per user per mod (unique constraint) ──────
      const existingReport = await prisma.report.findUnique({
        where: { modId_reporterId: { modId, reporterId: user.id } },
      });

      if (existingReport) {
        res
          .status(409)
          .json({ error: 'You have already submitted a report for this mod' });
        return;
      }

      // ── Create the report ───────────────────────────────────────────
      const report = await prisma.report.create({
        data: {
          modId,
          reporterId: user.id,
          reason,
          details: details ?? null,
          status: 'open',
        },
        include: {
          mod: { select: { id: true, title: true } },
          reporter: { select: { id: true, username: true, displayName: true } },
        },
      });

      // ── Notify all admin/owner users ────────────────────────────────
      const adminUsers = await prisma.user.findMany({
        where: { role: { in: ['admin', 'owner'] } },
        select: { id: true, email: true },
      });

      // Create in-app notifications for each admin
      if (adminUsers.length > 0) {
        await prisma.notification.createMany({
          data: adminUsers.map((admin: { id: string; email: string }) => ({
            userId: admin.id,
            type: 'report' as const,
            title: 'New Mod Report',
            message: `${user.username} reported "${mod.title}" for ${reason.replace(/_/g, ' ')}`,
            link: `/admin/reports/${report.id}`,
          })),
        });
      }

      // Emit real-time event to admin Socket.IO room
      emitToAdmins('report:new', {
        modTitle: mod.title,
        reason,
        reporterUsername: user.username,
      });

      // Send email alert to all admin emails (fire-and-forget)
      const adminEmails = adminUsers.map((a: { id: string; email: string }) => a.email);
      if (adminEmails.length > 0) {
        sendReportAlert(adminEmails, mod.title, reason.replace(/_/g, ' '));
      }

      // ── Log activity ────────────────────────────────────────────────
      await prisma.activityLog.create({
        data: {
          type: 'report',
          message: `${user.username} reported mod "${mod.title}" for ${reason.replace(/_/g, ' ')}`,
          userId: user.id,
          metadata: { modId, reportId: report.id, reason },
        },
      });

      res.status(201).json(report);
    } catch (err) {
      console.error('[POST /reports/mod/:modId]', err);
      res.status(500).json({ error: 'Failed to submit report' });
    }
  },
);

/**
 * GET /mine — Retrieve the authenticated user's submitted reports.
 *
 * Returns reports with mod title and status, sorted newest first.
 */
router.get(
  '/mine',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;

      const reports = await prisma.report.findMany({
        where: { reporterId: user.id },
        include: {
          mod: { select: { id: true, title: true, iconUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ reports });
    } catch (err) {
      console.error('[GET /reports/mine]', err);
      res.status(500).json({ error: 'Failed to fetch your reports' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES — require admin or owner role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/all — List all reports with pagination and filtering.
 *
 * Query params: page, limit, status, reason
 * Includes mod info and reporter info.
 */
router.get(
  '/admin/all',
  requireAuth,
  requireRole('admin', 'owner'),
  validate({ query: adminReportsQuerySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { page, limit, status, reason } =
        (res.locals.validated?.query ?? req.query) as z.infer<typeof adminReportsQuerySchema>;

      // ── Build dynamic where clause ────────────────────────────────
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (reason) where.reason = reason;

      const skip = (page - 1) * limit;

      const [reports, total] = await Promise.all([
        prisma.report.findMany({
          where,
          include: {
            mod: { select: { id: true, title: true, iconUrl: true } },
            reporter: {
              select: { id: true, username: true, displayName: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.report.count({ where }),
      ]);

      res.json({
        reports,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[GET /reports/admin/all]', err);
      res.status(500).json({ error: 'Failed to fetch reports' });
    }
  },
);

/**
 * GET /admin/stats — Report statistics (count by status).
 */
router.get(
  '/admin/stats',
  requireAuth,
  requireRole('admin', 'owner'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const [open, investigating, resolved, dismissed, total] =
        await Promise.all([
          prisma.report.count({ where: { status: 'open' } }),
          prisma.report.count({ where: { status: 'investigating' } }),
          prisma.report.count({ where: { status: 'resolved' } }),
          prisma.report.count({ where: { status: 'dismissed' } }),
          prisma.report.count(),
        ]);

      res.json({ open, investigating, resolved, dismissed, total });
    } catch (err) {
      console.error('[GET /reports/admin/stats]', err);
      res.status(500).json({ error: 'Failed to fetch report statistics' });
    }
  },
);

/**
 * PUT /admin/:id — Update a report's status and optional admin notes.
 *
 * When resolving or dismissing, records who resolved it and when.
 */
router.put(
  '/admin/:id',
  requireAuth,
  requireRole('admin', 'owner'),
  validate({ body: updateReportSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Report ID is required' });
        return;
      }
      const admin = req.user!;
      const { status, adminNotes } = req.body as z.infer<typeof updateReportSchema>;

      // ── Verify report exists ────────────────────────────────────────
      const existing = await prisma.report.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      // ── Build update data ───────────────────────────────────────────
      const updateData: Record<string, unknown> = { status };
      if (adminNotes !== undefined) updateData.adminNotes = adminNotes;

      // Set resolver info when resolving or dismissing
      if (status === 'resolved' || status === 'dismissed') {
        updateData.resolvedById = admin.id;
        updateData.resolvedAt = new Date();
      }

      const report = await prisma.report.update({
        where: { id },
        data: updateData,
        include: {
          mod: { select: { id: true, title: true } },
          reporter: { select: { id: true, username: true, displayName: true } },
          resolvedBy: { select: { id: true, username: true } },
        },
      });

      res.json(report);
    } catch (err) {
      console.error('[PUT /reports/admin/:id]', err);
      res.status(500).json({ error: 'Failed to update report' });
    }
  },
);

/**
 * PUT /admin/:id/action — Take a specific action on a report.
 *
 * Actions:
 *   - resolve:      mark as resolved
 *   - dismiss:      mark as dismissed
 *   - remove_mod:   soft-delete the mod and resolve the report
 *   - ban_reporter: ban the reporter (for false reports) and dismiss the report
 */
router.put(
  '/admin/:id/action',
  requireAuth,
  requireRole('admin', 'owner'),
  validate({ body: reportActionSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Report ID is required' });
        return;
      }
      const admin = req.user!;
      const { action } = req.body as z.infer<typeof reportActionSchema>;

      // ── Verify report exists with related data ──────────────────────
      const report = await prisma.report.findUnique({
        where: { id },
        include: {
          mod: { select: { id: true, title: true, status: true } },
          reporter: { select: { id: true, username: true, role: true } },
        },
      });

      if (!report) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      // ── Execute action ──────────────────────────────────────────────
      switch (action) {
        case 'resolve': {
          await prisma.report.update({
            where: { id },
            data: {
              status: 'resolved',
              resolvedById: admin.id,
              resolvedAt: new Date(),
            },
          });
          break;
        }

        case 'dismiss': {
          await prisma.report.update({
            where: { id },
            data: {
              status: 'dismissed',
              resolvedById: admin.id,
              resolvedAt: new Date(),
            },
          });
          break;
        }

        case 'remove_mod': {
          // Soft-delete the reported mod
          await prisma.mod.update({
            where: { id: report.modId },
            data: { status: 'deleted' },
          });

          // Mark report as resolved
          await prisma.report.update({
            where: { id },
            data: {
              status: 'resolved',
              resolvedById: admin.id,
              resolvedAt: new Date(),
            },
          });

          // Log the mod removal activity
          await prisma.activityLog.create({
            data: {
              type: 'delete',
              message: `Admin ${admin.username} removed mod "${report.mod.title}" via report action`,
              userId: admin.id,
              metadata: {
                modId: report.modId,
                reportId: id,
                action: 'remove_mod',
              },
            },
          });
          break;
        }

        case 'ban_reporter': {
          // Prevent banning admin/owner reporters
          if (
            report.reporter.role === 'admin' ||
            report.reporter.role === 'owner'
          ) {
            res
              .status(403)
              .json({ error: 'Cannot ban an admin or owner user' });
            return;
          }

          // Ban the reporter for filing a false report
          await prisma.user.update({
            where: { id: report.reporterId },
            data: {
              status: 'banned',
              banReason: 'Banned for filing a false report',
            },
          });

          // Dismiss the report
          await prisma.report.update({
            where: { id },
            data: {
              status: 'dismissed',
              resolvedById: admin.id,
              resolvedAt: new Date(),
              adminNotes:
                (report.adminNotes ? report.adminNotes + '\n' : '') +
                'Reporter banned for false report.',
            },
          });

          // Log the ban activity
          await prisma.activityLog.create({
            data: {
              type: 'ban',
              message: `Admin ${admin.username} banned user ${report.reporter.username} for false report`,
              userId: admin.id,
              metadata: {
                bannedUserId: report.reporterId,
                reportId: id,
                action: 'ban_reporter',
              },
            },
          });
          break;
        }
      }

      res.json({ success: true, action });
    } catch (err) {
      console.error('[PUT /reports/admin/:id/action]', err);
      res.status(500).json({ error: 'Failed to execute report action' });
    }
  },
);

/**
 * DELETE /admin/:id — Hard-delete a report.
 */
router.delete(
  '/admin/:id',
  requireAuth,
  requireRole('admin', 'owner'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Report ID is required' });
        return;
      }

      const existing = await prisma.report.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Report not found' });
        return;
      }

      await prisma.report.delete({ where: { id } });

      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /reports/admin/:id]', err);
      res.status(500).json({ error: 'Failed to delete report' });
    }
  },
);

export default router;
