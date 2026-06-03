import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { emitToUser } from '../lib/socket.js';

// =============================================================================
// Router
// =============================================================================

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /mod/:modId  — Toggle like on a mod.
//
// - If already liked → remove like and decrement mod.likesCount.
// - If not liked → create like and increment mod.likesCount.
// - Emits a notification to the mod author when a new like is added
//   (skipped when liking your own mod).
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/mod/:modId',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const rawModId = req.params.modId;
      const modId = Array.isArray(rawModId) ? rawModId[0] : rawModId;
      if (!modId) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }

      // Verify the mod exists and is published
      const mod = await prisma.mod.findUnique({ where: { id: modId } });
      if (!mod || mod.status !== 'published') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      // Check for an existing like
      const existingLike = await prisma.like.findUnique({
        where: { modId_userId: { modId, userId: user.id } },
      });

      let liked: boolean;
      let updatedMod: { likesCount: number };

      if (existingLike) {
        // ── Unlike: remove like and decrement counter ─────────────────
        [, updatedMod] = await prisma.$transaction([
          prisma.like.delete({
            where: { id: existingLike.id },
          }),
          prisma.mod.update({
            where: { id: modId },
            data: { likesCount: { decrement: 1 } },
            select: { likesCount: true },
          }),
        ]);
        liked = false;
      } else {
        // ── Like: create like and increment counter ───────────────────
        [, updatedMod] = await prisma.$transaction([
          prisma.like.create({
            data: { modId, userId: user.id },
          }),
          prisma.mod.update({
            where: { id: modId },
            data: { likesCount: { increment: 1 } },
            select: { likesCount: true },
          }),
        ]);
        liked = true;

        // Log like activity
        await prisma.activityLog.create({
          data: {
            type: 'like',
            message: `${user.username} liked "${mod.title}"`,
            userId: user.id,
            metadata: { modId },
          },
        });

        // ── Notify mod author (only if it's not your own mod) ────────
        if (mod.authorId !== user.id) {
          const notification = await prisma.notification.create({
            data: {
              userId: mod.authorId,
              type: 'like',
              title: 'New Like',
              message: `${user.username} liked your mod "${mod.title}"`,
              link: `/mods/${modId}`,
            },
          });

          emitToUser(mod.authorId, 'notification', notification);
        }
      }

      res.json({ liked, likesCount: updatedMod.likesCount });
    } catch (err) {
      console.error('[POST /likes/mod/:modId]', err);
      res.status(500).json({ error: 'Failed to toggle like' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /mod/:modId/status  — Check like status for a mod.
//
// - Authenticated users get their personal like flag.
// - Anonymous users always get `liked: false`.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/mod/:modId/status',
  optionalAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const rawModId = req.params.modId;
      const modId = Array.isArray(rawModId) ? rawModId[0] : rawModId;
      if (!modId) {
        res.status(400).json({ error: 'Mod ID is required' });
        return;
      }

      // Verify the mod exists
      const mod = await prisma.mod.findUnique({
        where: { id: modId },
        select: { likesCount: true, status: true },
      });

      if (!mod || mod.status === 'deleted') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      let liked = false;

      if (req.user) {
        const existingLike = await prisma.like.findUnique({
          where: { modId_userId: { modId, userId: req.user.id } },
        });
        liked = !!existingLike;
      }

      res.json({ liked, likesCount: mod.likesCount });
    } catch (err) {
      console.error('[GET /likes/mod/:modId/status]', err);
      res.status(500).json({ error: 'Failed to fetch like status' });
    }
  },
);

export default router;
