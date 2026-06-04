import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { emitToUser } from '../lib/socket.js';
import { uploadModIcon, uploadModGallery } from '../middleware/upload.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Strip sensitive fields (`downloadUrl`, `unlockCode`) from a mod object.
 * Admins receive the full object so they can manage content.
 */
const sanitizeMod = (mod: any, isAdmin = false) => {
  const { downloadUrl, unlockCode, ...safe } = mod;
  if (isAdmin) return mod; // admins see everything
  return safe;
};

/**
 * Check whether a role string is privileged (admin or owner).
 */
const isPrivileged = (role?: string): boolean =>
  role === 'admin' || role === 'owner';

function getParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
}

// =============================================================================
// Zod Schemas
// =============================================================================

// ── Browse query params ─────────────────────────────────────────────────────

const browseQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, parseInt(v || '1', 10))),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '20', 10)))),
  search: z.string().optional(),
  game: z.enum(['fs22', 'fs25']).optional(),
  category: z.string().optional(),
  accessType: z.enum(['free', 'paid', 'unlock_code']).optional(),
  tags: z.string().optional(), // comma-separated
  sort: z
    .enum(['newest', 'oldest', 'downloads', 'views', 'likes'])
    .optional()
    .default('newest'),
  featured: z
    .string()
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

// ── Admin browse query params ───────────────────────────────────────────────

const adminBrowseQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, parseInt(v || '1', 10))),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '20', 10)))),
  search: z.string().optional(),
  status: z.enum(['published', 'pending', 'rejected', 'deleted']).optional(),
  game: z.enum(['fs22', 'fs25']).optional(),
  accessType: z.enum(['free', 'paid', 'unlock_code']).optional(),
});

// ── Create mod ──────────────────────────────────────────────────────────────

const createModSchema = z
  .object({
    title: z
      .string()
      .min(3, 'Title must be at least 3 characters')
      .max(100, 'Title must be at most 100 characters'),
    description: z
      .string()
      .min(10, 'Description must be at least 10 characters')
      .max(5000, 'Description must be at most 5000 characters'),
    shortDescription: z
      .string()
      .min(3, 'Short description must be at least 3 characters')
      .max(200, 'Short description must be at most 200 characters'),
    game: z.enum(['fs22', 'fs25']),
    version: z.string().optional().default('1.0.0'),
    tags: z.array(z.string()).optional().default([]),
    iconUrl: z.string().url('Invalid icon URL'),
    gallery: z.array(z.string().url()).optional().default([]),
    accessType: z.enum(['free', 'paid', 'unlock_code']).optional().default('free'),
    price: z.number().optional(),
    unlockCode: z.string().optional(),
    downloadUrl: z.string().url('Invalid download URL').optional(),
    category: z.string().min(1, 'Category is required'),
    fileSizeMb: z.number().min(0).optional().default(0),
  })
  .superRefine((data, ctx) => {
    // Paid mods must have a price > 0
    if (data.accessType === 'paid' && (!data.price || data.price <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Price must be greater than 0 for paid mods',
        path: ['price'],
      });
    }

    // Unlock-code mods must supply a code
    if (data.accessType === 'unlock_code' && !data.unlockCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unlock code is required for unlock_code mods',
        path: ['unlockCode'],
      });
    }

    // Free and unlock_code mods must have a download URL
    if (
      (data.accessType === 'free' || data.accessType === 'unlock_code') &&
      !data.downloadUrl
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Download URL is required for free and unlock_code mods',
        path: ['downloadUrl'],
      });
    }
  });

// ── Update mod ──────────────────────────────────────────────────────────────

const updateModSchema = z
  .object({
    title: z.string().min(3).max(100).optional(),
    description: z.string().min(10).max(5000).optional(),
    shortDescription: z.string().min(3).max(200).optional(),
    game: z.enum(['fs22', 'fs25']).optional(),
    version: z.string().optional(),
    tags: z.array(z.string()).optional(),
    iconUrl: z.string().url().optional(),
    gallery: z.array(z.string().url()).optional(),
    accessType: z.enum(['free', 'paid', 'unlock_code']).optional(),
    price: z.number().optional(),
    unlockCode: z.string().optional(),
    downloadUrl: z.string().url().optional(),
    category: z.string().optional(),
    fileSizeMb: z.number().min(0).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.accessType === 'paid' && data.price !== undefined && data.price <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Price must be greater than 0 for paid mods',
        path: ['price'],
      });
    }
    if (data.accessType === 'unlock_code' && data.unlockCode === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unlock code cannot be empty for unlock_code mods',
        path: ['unlockCode'],
      });
    }
  });

// ── Unlock body ─────────────────────────────────────────────────────────────

const unlockBodySchema = z.object({
  code: z.string().min(1, 'Unlock code is required'),
});

// ── Admin status update ─────────────────────────────────────────────────────

const adminStatusSchema = z.object({
  status: z.enum(['published', 'rejected']),
  reason: z.string().optional(), // reason when rejecting
});

// =============================================================================
// Shared Prisma includes / selects
// =============================================================================

/** Include the author's public profile fields on mod queries. */
const authorInclude = {
  author: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      isVerified: true,
    },
  },
} as const;

/** Sort mapping from user-facing name → Prisma `orderBy` clause. */
const sortMap: Record<string, object> = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  downloads: { downloads: 'desc' },
  views: { views: 'desc' },
  likes: { likesCount: 'desc' },
};

// =============================================================================
// Router
// =============================================================================

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /  — Browse published mods with filtering, search, and pagination.
 */
router.get(
  '/',
  validate({ query: browseQuerySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { page, limit, search, game, category, accessType, tags, sort, featured } =
        (res.locals.validated?.query ?? req.query) as z.infer<typeof browseQuerySchema>;

      // ── Build dynamic `where` clause ──────────────────────────────────
      const where: any = { status: 'published' };

      if (game) where.game = game;
      if (category) where.category = category;
      if (accessType) where.accessType = accessType;
      if (featured !== undefined) where.featured = featured;

      // Tag filter — match mods that have ALL specified tags
      if (tags) {
        const tagList = tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        if (tagList.length > 0) {
          where.tags = { hasEvery: tagList };
        }
      }

      // Full-text search across title, description, and tags
      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { tags: { has: search.toLowerCase() } },
        ];
      }

      // ── Query ─────────────────────────────────────────────────────────
      const skip = (page - 1) * limit;
      const orderBy = sortMap[sort ?? 'newest'];

      const [mods, total] = await Promise.all([
        prisma.mod.findMany({
          where,
          include: authorInclude,
          orderBy,
          skip,
          take: limit,
        }),
        prisma.mod.count({ where }),
      ]);

      res.json({
        mods: mods.map((m: any) => sanitizeMod(m)),
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[GET /mods]', err);
      res.status(500).json({ error: 'Failed to fetch mods' });
    }
  },
);

/**
 * GET /featured  — Returns up to 10 featured published mods.
 */
router.get('/featured', async (_req: Request, res: Response): Promise<void> => {
  try {
    const mods = await prisma.mod.findMany({
      where: { status: 'published', featured: true },
      include: authorInclude,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    res.json({ mods: mods.map((m: any) => sanitizeMod(m)) });
  } catch (err) {
    console.error('[GET /mods/featured]', err);
    res.status(500).json({ error: 'Failed to fetch featured mods' });
  }
});

/**
 * GET /stats  — Aggregate platform statistics.
 */
router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [modAgg, totalUsers] = await Promise.all([
      prisma.mod.aggregate({
        where: { status: 'published' },
        _sum: { downloads: true, views: true, shares: true },
        _count: true,
      }),
      prisma.user.count(),
    ]);

    // Break down by access type
    const [freeMods, paidMods, codeMods] = await Promise.all([
      prisma.mod.count({ where: { status: 'published', accessType: 'free' } }),
      prisma.mod.count({ where: { status: 'published', accessType: 'paid' } }),
      prisma.mod.count({ where: { status: 'published', accessType: 'unlock_code' } }),
    ]);

    res.json({
      totalMods: modAgg._count,
      totalDownloads: modAgg._sum.downloads ?? 0,
      totalViews: modAgg._sum.views ?? 0,
      totalShares: modAgg._sum.shares ?? 0,
      totalUsers,
      freeMods,
      paidMods,
      codeMods,
    });
  } catch (err) {
    console.error('[GET /mods/stats]', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /:id  — Get a single mod by ID.
 *
 * - Increments views (fire & forget).
 * - Never returns downloadUrl to non-admin users.
 * - Includes review stats, likes count, and optional user interaction flags.
 */
router.get(
  '/:id',
  optionalAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }

      const mod = await prisma.mod.findUnique({
        where: { id },
        include: {
          ...authorInclude,
          reviews: {
            select: { rating: true },
          },
          _count: {
            select: { likes: true, reviews: true },
          },
        },
      });

      if (!mod || mod.status === 'deleted') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      // Fire-and-forget view increment
      prisma.mod
        .update({ where: { id }, data: { views: { increment: 1 } } })
        .catch(() => {});

      // Compute review stats
      const totalReviews = mod._count.reviews;
      const avgRating =
        totalReviews > 0
          ? mod.reviews.reduce((sum: number, r: { rating: number }) => sum + r.rating, 0) / totalReviews
          : 0;

      // Build user-specific flags if authenticated
      let userLiked = false;
      let userReviewed = false;
      let userReported = false;
      let userUnlocked = false;

      if (req.user) {
        const userId = req.user.id;

        const [likeRecord, reviewRecord, reportRecord] = await Promise.all([
          prisma.like.findUnique({
            where: { modId_userId: { modId: id, userId } },
          }),
          prisma.review.findUnique({
            where: { modId_userId: { modId: id, userId } },
          }),
          prisma.report.findFirst({
            where: { modId: id, reporterId: userId },
          }),
        ]);

        userLiked = !!likeRecord;
        userReviewed = !!reviewRecord;
        userReported = !!reportRecord;

        // For unlock_code mods, check if user previously downloaded (activity log)
        if (mod.accessType === 'unlock_code') {
          const unlockLog = await prisma.activityLog.findFirst({
            where: {
              userId,
              type: 'unlock',
              metadata: { path: ['modId'], equals: id },
            },
          });
          userUnlocked = !!unlockLog;
        }
      }

      // Strip the raw reviews array — we've summarised it into avgRating / totalReviews
      const { reviews: _reviews, _count, ...modData } = mod as any;

      const response: any = {
        ...sanitizeMod(modData),
        avgRating: Math.round(avgRating * 10) / 10,
        totalReviews,
        likesCount: _count.likes,
      };

      if (req.user) {
        response.userLiked = userLiked;
        response.userReviewed = userReviewed;
        response.userReported = userReported;
        if (mod.accessType === 'unlock_code') {
          response.userUnlocked = userUnlocked;
        }
      }

      res.json(response);
    } catch (err) {
      console.error('[GET /mods/:id]', err);
      res.status(500).json({ error: 'Failed to fetch mod' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH-REQUIRED ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /  — Create a new mod.
 *
 * Roles: modder, admin, owner.
 * Status is `pending` for modders (needs admin approval), `published` for
 * admin/owner.
 */
router.post(
  '/',
  requireAuth,
  requireRole('modder', 'admin', 'owner'),
  validate({ body: createModSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const data = req.body as z.infer<typeof createModSchema>;
      const user = req.user!;

      const status = isPrivileged(user.role) ? 'published' : 'pending';

      const mod = await prisma.mod.create({
        data: {
          title: data.title,
          description: data.description,
          shortDescription: data.shortDescription,
          game: data.game,
          version: data.version ?? '1.0.0',
          tags: data.tags ?? [],
          iconUrl: data.iconUrl,
          gallery: data.gallery ?? [],
          accessType: data.accessType ?? 'free',
          price: data.price,
          unlockCode: data.unlockCode,
          downloadUrl: data.downloadUrl ?? '',
          category: data.category,
          fileSizeMb: data.fileSizeMb ?? 0,
          status,
          authorId: user.id,
        },
        include: authorInclude,
      });

      // Log the upload activity
      await prisma.activityLog.create({
        data: {
          type: 'upload',
          message: `${user.username} uploaded mod "${mod.title}"`,
          userId: user.id,
          metadata: { modId: mod.id },
        },
      });

      res.status(201).json(sanitizeMod(mod));
    } catch (err) {
      console.error('[POST /mods]', err);
      res.status(500).json({ error: 'Failed to create mod' });
    }
  },
);

/**
 * PUT /:id  — Update a mod.
 *
 * Authors can update their own mods. Admins / owners can update any mod.
 */
router.put(
  '/:id',
  requireAuth,
  validate({ body: updateModSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const user = req.user!;

      const existing = await prisma.mod.findUnique({ where: { id } });
      if (!existing || existing.status === 'deleted') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      // Ownership check
      if (existing.authorId !== user.id && !isPrivileged(user.role)) {
        res.status(403).json({ error: 'You can only update your own mods' });
        return;
      }

      const data = req.body as z.infer<typeof updateModSchema>;

      const mod = await prisma.mod.update({
        where: { id },
        data,
        include: authorInclude,
      });

      res.json(sanitizeMod(mod, isPrivileged(user.role)));
    } catch (err) {
      console.error('[PUT /mods/:id]', err);
      res.status(500).json({ error: 'Failed to update mod' });
    }
  },
);

/**
 * DELETE /:id  — Soft-delete a mod (sets status to `deleted`).
 *
 * Authors can delete their own mods. Admins / owners can delete any mod.
 */
router.delete(
  '/:id',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const user = req.user!;

      const existing = await prisma.mod.findUnique({ where: { id } });
      if (!existing || existing.status === 'deleted') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      if (existing.authorId !== user.id && !isPrivileged(user.role)) {
        res.status(403).json({ error: 'You can only delete your own mods' });
        return;
      }

      await prisma.mod.update({
        where: { id },
        data: { status: 'deleted' },
      });

      // Log activity
      await prisma.activityLog.create({
        data: {
          type: 'delete',
          message: `${user.username} deleted mod "${existing.title}"`,
          userId: user.id,
          metadata: { modId: id },
        },
      });

      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /mods/:id]', err);
      res.status(500).json({ error: 'Failed to delete mod' });
    }
  },
);

/**
 * POST /:id/download  — Request the download URL for a mod.
 *
 * Access control:
 *   - `free`        → always allowed.
 *   - `unlock_code` → allowed if user has a prior unlock activity log.
 *   - `paid`        → allowed if a Chat with status `paid` exists between user & mod.
 */
router.post(
  '/:id/download',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const user = req.user!;

      const mod = await prisma.mod.findUnique({ where: { id } });
      if (!mod || mod.status !== 'published') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      // ── Access checks ───────────────────────────────────────────────
      if (mod.accessType === 'unlock_code') {
        // Must have previously unlocked
        const unlockLog = await prisma.activityLog.findFirst({
          where: {
            userId: user.id,
            type: 'unlock',
            metadata: { path: ['modId'], equals: id },
          },
        });
        if (!unlockLog) {
          res.status(403).json({ error: 'You must unlock this mod first' });
          return;
        }
      } else if (mod.accessType === 'paid') {
        // Check for a paid chat between buyer and mod
        const paidChat = await prisma.chat.findFirst({
          where: {
            modId: id,
            buyerId: user.id,
            status: 'paid',
          },
        });
        if (!paidChat) {
          res
            .status(403)
            .json({ error: 'You must purchase this mod before downloading' });
          return;
        }
      }
      // 'free' → no check needed

      // Increment download count
      await prisma.mod.update({
        where: { id },
        data: { downloads: { increment: 1 } },
      });

      // Log download activity
      await prisma.activityLog.create({
        data: {
          type: 'download',
          message: `${user.username} downloaded mod "${mod.title}"`,
          userId: user.id,
          metadata: { modId: id },
        },
      });

      res.json({ downloadUrl: mod.downloadUrl });
    } catch (err) {
      console.error('[POST /mods/:id/download]', err);
      res.status(500).json({ error: 'Failed to process download' });
    }
  },
);

/**
 * POST /:id/unlock  — Attempt to unlock an `unlock_code` mod.
 *
 * Compares the provided code (case-insensitive) against the stored unlockCode.
 * On success, returns the download URL and logs the unlock.
 */
router.post(
  '/:id/unlock',
  requireAuth,
  validate({ body: unlockBodySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const user = req.user!;
      const { code } = req.body as z.infer<typeof unlockBodySchema>;

      const mod = await prisma.mod.findUnique({ where: { id } });
      if (!mod || mod.status !== 'published') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      if (mod.accessType !== 'unlock_code') {
        res.status(400).json({ error: 'This mod does not use an unlock code' });
        return;
      }

      // Case-insensitive comparison
      if (code.toLowerCase() !== mod.unlockCode?.toLowerCase()) {
        res.status(400).json({ error: 'Invalid unlock code' });
        return;
      }

      // Increment downloads
      await prisma.mod.update({
        where: { id },
        data: { downloads: { increment: 1 } },
      });

      // Log unlock activity
      await prisma.activityLog.create({
        data: {
          type: 'unlock',
          message: `${user.username} unlocked mod "${mod.title}"`,
          userId: user.id,
          metadata: { modId: id },
        },
      });

      res.json({ success: true, downloadUrl: mod.downloadUrl });
    } catch (err) {
      console.error('[POST /mods/:id/unlock]', err);
      res.status(500).json({ error: 'Failed to unlock mod' });
    }
  },
);

/**
 * POST /:id/share  — Increment the share counter.
 */
router.post(
  '/:id/share',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }

      const mod = await prisma.mod.findUnique({ where: { id } });
      if (!mod || mod.status !== 'published') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      const updated = await prisma.mod.update({
        where: { id },
        data: { shares: { increment: 1 } },
        select: { shares: true },
      });

      res.json({ shares: updated.shares });
    } catch (err) {
      console.error('[POST /mods/:id/share]', err);
      res.status(500).json({ error: 'Failed to share mod' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/all  — List ALL mods (every status) for admin management.
 *
 * Includes downloadUrl since admins need full visibility.
 */
router.get(
  '/admin/all',
  requireAuth,
  requireRole('modder', 'admin', 'owner'),
  validate({ query: adminBrowseQuerySchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { page, limit, search, status, game, accessType } =
        (res.locals.validated?.query ?? req.query) as z.infer<typeof adminBrowseQuerySchema>;

      const where: any = {};

      if (req.user?.role === 'modder' && req.user?.id) {
        where.authorId = req.user.id;
      }

      if (status) where.status = status;
      if (game) where.game = game;
      if (accessType) where.accessType = accessType;

      if (search) {
        where.OR = [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ];
      }

      const skip = (page - 1) * limit;

      const [mods, total] = await Promise.all([
        prisma.mod.findMany({
          where,
          include: authorInclude,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.mod.count({ where }),
      ]);

      res.json({
        mods: mods.map((m: any) => sanitizeMod(m, true)), // admins see everything
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[GET /mods/admin/all]', err);
      res.status(500).json({ error: 'Failed to fetch mods' });
    }
  },
);

/**
 * PUT /admin/:id/feature  — Toggle the `featured` flag on a mod.
 */
router.put(
  '/admin/:id/feature',
  requireAuth,
  requireRole('admin', 'owner'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const user = req.user!;

      const existing = await prisma.mod.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      const mod = await prisma.mod.update({
        where: { id },
        data: { featured: !existing.featured },
        include: authorInclude,
      });

      // Log feature activity
      await prisma.activityLog.create({
        data: {
          type: 'feature',
          message: `${user.username} ${mod.featured ? 'featured' : 'unfeatured'} mod "${mod.title}"`,
          userId: user.id,
          metadata: { modId: id, featured: mod.featured },
        },
      });

      res.json(sanitizeMod(mod, true));
    } catch (err) {
      console.error('[PUT /mods/admin/:id/feature]', err);
      res.status(500).json({ error: 'Failed to toggle feature status' });
    }
  },
);

/**
 * PUT /admin/:id/status  — Set a mod's publication status (published / rejected).
 *
 * Sends a real-time notification to the mod author via Socket.IO.
 */
router.put(
  '/admin/:id/status',
  requireAuth,
  requireRole('admin', 'owner'),
  validate({ body: adminStatusSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }
      const user = req.user!;
      const { status, reason } = req.body as z.infer<typeof adminStatusSchema>;

      const existing = await prisma.mod.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      const mod = await prisma.mod.update({
        where: { id },
        data: { status },
        include: authorInclude,
      });

      // ── Notify the mod author ─────────────────────────────────────────
      const isApproved = status === 'published';
      const notificationType = isApproved ? 'mod_approved' : 'mod_rejected';
      const notificationTitle = isApproved
        ? 'Mod Approved!'
        : 'Mod Rejected';
      const notificationMessage = isApproved
        ? `Your mod "${mod.title}" has been approved and is now published.`
        : `Your mod "${mod.title}" was rejected.${reason ? ` Reason: ${reason}` : ''}`;

      // Persist the notification
      const notification = await prisma.notification.create({
        data: {
          userId: mod.authorId,
          type: notificationType,
          title: notificationTitle,
          message: notificationMessage,
          link: `/mods/${mod.id}`,
        },
      });

      // Push via WebSocket so the author sees it instantly
      emitToUser(mod.authorId, 'notification', notification);

      res.json(sanitizeMod(mod, true));
    } catch (err) {
      console.error('[PUT /mods/admin/:id/status]', err);
      res.status(500).json({ error: 'Failed to update mod status' });
    }
  },
);

// =============================================================================
// Upload Routes
// =============================================================================

/**
 * POST /upload/icon — Upload a mod icon
 *
 * Returns the URL path to the uploaded icon.
 */
router.post(
  '/upload/icon',
  requireAuth,
  requireRole('modder', 'admin', 'owner'),
  uploadModIcon,
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No icon file provided' });
        return;
      }

      const iconUrl = `/uploads/mods/icons/${req.file.filename}`;
      res.json({ iconUrl });
    } catch (err) {
      console.error('[POST /mods/upload/icon]', err);
      res.status(500).json({ error: 'Failed to upload icon' });
    }
  },
);

/**
 * POST /upload/gallery — Upload mod gallery images (up to 10)
 *
 * Returns an array of URL paths to the uploaded images.
 */
router.post(
  '/upload/gallery',
  requireAuth,
  requireRole('modder', 'admin', 'owner'),
  uploadModGallery,
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({ error: 'No gallery images provided' });
        return;
      }

      const galleryUrls = req.files.map((file) => `/uploads/mods/gallery/${file.filename}`);
      res.json({ galleryUrls });
    } catch (err) {
      console.error('[POST /mods/upload/gallery]', err);
      res.status(500).json({ error: 'Failed to upload gallery images' });
    }
  },
);

// =============================================================================
// Export
// =============================================================================

export default router;
