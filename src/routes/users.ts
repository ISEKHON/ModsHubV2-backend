import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, comparePassword } from '../lib/auth.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadAvatar } from '../middleware/upload.js';
import { emitToUser } from '../lib/socket.js';
import { sendBanNotice } from '../lib/email.js';

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

function getParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const updateProfileSchema = z.object({
  displayName: z
    .string()
    .min(2, 'Display name must be at least 2 characters')
    .max(30, 'Display name must be at most 30 characters')
    .optional(),
  bio: z.string().max(500, 'Bio must be at most 500 characters').optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6, 'Password must be at least 6 characters').optional(),
});

const updateRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'modder', 'member'], {
    errorMap: () => ({ message: 'Invalid role. Must be one of: owner, admin, modder, member' }),
  }),
});

const banUserSchema = z.object({
  reason: z.string().min(1, 'Ban reason is required'),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const adminListSchema = paginationSchema.extend({
  search: z.string().optional(),
  role: z.enum(['owner', 'admin', 'modder', 'member']).optional(),
  status: z.enum(['active', 'banned']).optional(),
});

// ---------------------------------------------------------------------------
// GET /:username — Public profile
// ---------------------------------------------------------------------------

router.get('/:username', async (req, res, next) => {
  try {
    const { username } = req.params;

    const user = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isVerified: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Aggregate mod statistics: total published mods, total downloads, total likes
    const modStats = await prisma.mod.aggregate({
      where: { authorId: user.id, status: 'published' },
      _count: { id: true },
      _sum: {
        downloads: true,
        likesCount: true,
      },
    });

    res.json({
      user: {
        ...user,
        totalMods: modStats._count.id,
        totalDownloads: modStats._sum.downloads ?? 0,
        totalLikes: modStats._sum.likesCount ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:username/mods — Public mods by user
// ---------------------------------------------------------------------------

router.get('/:username/mods', async (req, res, next) => {
  try {
    const { username } = req.params;

    // Validate pagination query params
    const { page, limit } = paginationSchema.parse(req.query);

    // Resolve user first
    const user = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const where = { authorId: user.id, status: 'published' as const };

    const [mods, total] = await Promise.all([
      prisma.mod.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.mod.count({ where }),
    ]);

    res.json({
      mods,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /me — Update own profile (auth required)
// ---------------------------------------------------------------------------

router.put(
  '/me',
  requireAuth,
  validate({ body: updateProfileSchema }),
  async (req, res, next) => {
    try {
      const { displayName, bio, currentPassword, newPassword } = req.body;

      // Build the data object for the update
      const updateData: Record<string, unknown> = {};

      if (displayName !== undefined) updateData.displayName = displayName;
      if (bio !== undefined) updateData.bio = bio;

      // Handle password change
      if (newPassword) {
        if (!currentPassword) {
          res
            .status(400)
            .json({ error: 'Current password is required to set a new password' });
          return;
        }

        // Fetch current hash to verify
        const existing = await prisma.user.findUnique({
          where: { id: req.user!.id },
          select: { passwordHash: true },
        });

        if (!existing) {
          res.status(404).json({ error: 'User not found' });
          return;
        }

        const valid = await comparePassword(currentPassword, existing.passwordHash);
        if (!valid) {
          res.status(401).json({ error: 'Current password is incorrect' });
          return;
        }

        updateData.passwordHash = await hashPassword(newPassword);
      }

      const user = await prisma.user.update({
        where: { id: req.user!.id },
        data: updateData,
      });

      res.json({ user: sanitizeUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /me/avatar — Upload avatar (auth required)
// ---------------------------------------------------------------------------

router.post('/me/avatar', requireAuth, uploadAvatar, async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No avatar file provided' });
      return;
    }

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { avatarUrl },
    });

    res.json({ avatarUrl });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Admin routes — require admin or owner role
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /admin/all — List all users (paginated, filterable)
// ---------------------------------------------------------------------------

router.get(
  '/admin/all',
  requireAuth,
  requireRole('admin', 'owner'),
  async (req, res, next) => {
    try {
      const { page, limit, search, role, status } = adminListSchema.parse(req.query);

      // Build Prisma where clause from query params
      const where: Record<string, unknown> = {};

      if (search) {
        where.OR = [
          { username: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { displayName: { contains: search, mode: 'insensitive' } },
        ];
      }

      if (role) where.role = role;
      if (status) where.status = status;

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            _count: {
              select: {
                mods: true,
                reviews: true,
                likes: true,
              },
            },
          },
        }),
        prisma.user.count({ where }),
      ]);

      res.json({
        users: users.map(sanitizeUser),
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /admin/:id/role — Change user role
// ---------------------------------------------------------------------------

router.put(
  '/admin/:id/role',
  requireAuth,
  requireRole('admin', 'owner'),
  validate({ body: updateRoleSchema }),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const { role: newRole } = req.body;

      // Fetch the target user
      const targetUser = await prisma.user.findUnique({ where: { id } });
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const isOwner = req.user!.role === 'owner';

      // Non-owners cannot promote to owner or modify owners/admins
      if (!isOwner) {
        if (newRole === 'owner') {
          res.status(403).json({ error: 'Only owners can assign the owner role' });
          return;
        }
        if (targetUser.role === 'owner' || targetUser.role === 'admin') {
          res.status(403).json({ error: 'Admins cannot modify owners or other admins' });
          return;
        }
      }

      const updatedUser = await prisma.user.update({
        where: { id },
        data: { role: newRole },
      });

      // Notify the affected user in real-time
      emitToUser(id, 'user:role-changed', {
        role: newRole,
        message: `Your role has been changed to ${newRole}`,
      });

      res.json({ user: sanitizeUser(updatedUser) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /admin/:id/ban — Ban a user
// ---------------------------------------------------------------------------

router.put(
  '/admin/:id/ban',
  requireAuth,
  requireRole('admin', 'owner'),
  validate({ body: banUserSchema }),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;
      const { reason } = req.body;

      const targetUser = await prisma.user.findUnique({ where: { id } });
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const isOwner = req.user!.role === 'owner';

      // Cannot ban owners. Admins cannot ban other admins.
      if (targetUser.role === 'owner') {
        res.status(403).json({ error: 'Cannot ban the owner' });
        return;
      }
      if (!isOwner && targetUser.role === 'admin') {
        res.status(403).json({ error: 'Admins cannot ban other admins' });
        return;
      }

      const updatedUser = await prisma.user.update({
        where: { id },
        data: { status: 'banned', banReason: reason },
      });

      // Notify the user in real-time
      emitToUser(id, 'user:banned', {
        reason,
        message: 'Your account has been banned',
      });

      // Send email notification (fire-and-forget — sendBanNotice never throws)
      sendBanNotice(targetUser.email, reason);

      // Log the ban activity
      await prisma.activityLog.create({
        data: {
          type: 'ban',
          message: `User ${targetUser.username} was banned: ${reason}`,
          userId: req.user!.id,
          metadata: { bannedUserId: id, reason },
        },
      });

      res.json({ user: sanitizeUser(updatedUser) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /admin/:id/unban — Unban a user
// ---------------------------------------------------------------------------

router.put(
  '/admin/:id/unban',
  requireAuth,
  requireRole('admin', 'owner'),
  async (req, res, next) => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'User ID is required' });
        return;
      }

      const targetUser = await prisma.user.findUnique({ where: { id } });
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const updatedUser = await prisma.user.update({
        where: { id },
        data: { status: 'active', banReason: null },
      });

      res.json({ user: sanitizeUser(updatedUser) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /admin/:id/verify — Toggle user verification
// ---------------------------------------------------------------------------

router.put(
  '/admin/:id/verify',
  requireAuth,
  requireRole('admin', 'owner'),
  async (req, res, next) => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'User ID is required' });
        return;
      }

      const targetUser = await prisma.user.findUnique({ where: { id } });
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // Toggle: if already verified → unverify, otherwise → verify
      const isCurrentlyVerified = targetUser.isVerified;

      const updatedUser = await prisma.user.update({
        where: { id },
        data: {
          isVerified: !isCurrentlyVerified,
          verifiedAt: isCurrentlyVerified ? null : new Date(),
          verifiedById: isCurrentlyVerified ? null : req.user!.id,
        },
      });

      res.json({ user: sanitizeUser(updatedUser) });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /admin/:id — Delete a user
// ---------------------------------------------------------------------------

router.delete(
  '/admin/:id',
  requireAuth,
  requireRole('admin', 'owner'),
  async (req, res, next) => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'User ID is required' });
        return;
      }

      const targetUser = await prisma.user.findUnique({ where: { id } });
      if (!targetUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      if (targetUser.role === 'owner') {
        res.status(403).json({ error: 'Cannot delete the owner account' });
        return;
      }

      // Hard delete — cascades are handled by Prisma schema relations
      await prisma.user.delete({ where: { id } });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
