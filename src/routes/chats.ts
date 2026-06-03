import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { emitToUser, emitToRoom } from '../lib/socket.js';
import { sendChatNotification } from '../lib/email.js';
import { uploadChatImage } from '../middleware/upload.js';

// =============================================================================
// Zod Schemas
// =============================================================================

// ── Initiate chat body ──────────────────────────────────────────────────────

const initiateChatSchema = z.object({
  modId: z.string().uuid('Invalid mod ID'),
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message must be at most 2000 characters'),
});

// ── Send message body ───────────────────────────────────────────────────────

const sendMessageSchema = z.object({
  content: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message must be at most 2000 characters'),
});

// ── Admin status update body ────────────────────────────────────────────────

const adminChatStatusSchema = z.object({
  status: z.enum(['paid', 'archived', 'closed']),
});

// ── Participant status update body ───────────────────────────────────────

const chatStatusSchema = z.object({
  status: z.enum(['active', 'paid', 'archived']),
});

// ── Pagination query params ─────────────────────────────────────────────────

const paginationQuery = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, parseInt(v || '1', 10))),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '50', 10)))),
});

// ── Admin list query params ─────────────────────────────────────────────────

const adminListQuery = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => Math.max(1, parseInt(v || '1', 10))),
  limit: z
    .string()
    .optional()
    .transform((v) => Math.min(100, Math.max(1, parseInt(v || '20', 10)))),
  status: z.enum(['active', 'paid', 'archived', 'closed']).optional(),
  search: z.string().optional(),
});

// =============================================================================
// Shared Prisma includes / selects
// =============================================================================

/** User fields safe to expose in chat context. */
const chatUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

/** Mod fields exposed on chat listings. */
const chatModSelect = {
  id: true,
  title: true,
  iconUrl: true,
} as const;

// =============================================================================
// Router
// =============================================================================

const router = Router();

function getParam(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] : value;
}

// All chat routes require authentication
router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES (registered first to avoid `:id` param catching "admin")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/all — List all chats with pagination, filtering, and search.
 *
 * Roles: admin, owner
 */
router.get(
  '/admin/all',
  requireRole('admin', 'owner'),
  validate({ query: adminListQuery }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { page, limit, status, search } =
        (res.locals.validated?.query ?? req.query) as z.infer<typeof adminListQuery>;

      // ── Build dynamic `where` clause ────────────────────────────────
      const where: any = {};

      if (status) where.status = status;

      if (search) {
        where.OR = [
          { mod: { title: { contains: search, mode: 'insensitive' } } },
          { buyer: { username: { contains: search, mode: 'insensitive' } } },
          { modder: { username: { contains: search, mode: 'insensitive' } } },
        ];
      }

      const skip = (page - 1) * limit;

      const [chats, total] = await Promise.all([
        prisma.chat.findMany({
          where,
          include: {
            mod: { select: chatModSelect },
            buyer: { select: chatUserSelect },
            modder: { select: chatUserSelect },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { content: true, imageUrl: true, createdAt: true },
            },
            _count: { select: { messages: true } },
          },
          orderBy: { updatedAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.chat.count({ where }),
      ]);

      // Flatten last message and message count
      const formatted = chats.map((chat: typeof chats[number]) => ({
        ...chat,
        lastMessage: chat.messages[0] ?? null,
        messageCount: chat._count.messages,
        messages: undefined,
        _count: undefined,
      }));

      res.json({
        chats: formatted,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[GET /chats/admin/all]', err);
      res.status(500).json({ error: 'Failed to fetch chats' });
    }
  },
);

/**
 * GET /admin/stats — Chat statistics for the admin dashboard.
 *
 * Roles: admin, owner
 */
router.get(
  '/admin/stats',
  requireRole('admin', 'owner'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const [totalChats, activeChats, paidChats, archivedChats] =
        await Promise.all([
          prisma.chat.count(),
          prisma.chat.count({ where: { status: 'active' } }),
          prisma.chat.count({ where: { status: 'paid' } }),
          prisma.chat.count({ where: { status: 'archived' } }),
        ]);

      res.json({ totalChats, activeChats, paidChats, archivedChats });
    } catch (err) {
      console.error('[GET /chats/admin/stats]', err);
      res.status(500).json({ error: 'Failed to fetch chat statistics' });
    }
  },
);

/**
 * PUT /admin/:id/status — Update a chat's status.
 *
 * Roles: admin, owner
 */
router.put(
  '/admin/:id/status',
  requireRole('admin', 'owner'),
  validate({ body: adminChatStatusSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Chat ID is required' });
        return;
      }
      const { status } = req.body as z.infer<typeof adminChatStatusSchema>;

      const existing = await prisma.chat.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      const chat = await prisma.chat.update({
        where: { id },
        data: { status },
        include: {
          mod: { select: chatModSelect },
          buyer: { select: chatUserSelect },
          modder: { select: chatUserSelect },
        },
      });

      res.json(chat);
    } catch (err) {
      console.error('[PUT /chats/admin/:id/status]', err);
      res.status(500).json({ error: 'Failed to update chat status' });
    }
  },
);

/**
 * PUT /:id/status — Update a chat's status (modder/admin/owner only).
 */
router.put(
  '/:id/status',
  validate({ body: chatStatusSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Chat ID is required' });
        return;
      }
      const user = req.user!;
      const { status } = req.body as z.infer<typeof chatStatusSchema>;

      const existing = await prisma.chat.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      const isPrivileged = user.role === 'admin' || user.role === 'owner';
      const isModder = existing.modderId === user.id;
      if (!isPrivileged && !isModder) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const chat = await prisma.chat.update({
        where: { id },
        data: { status },
      });

      emitToUser(existing.buyerId, 'chat:status', { chatId: id, status });
      emitToUser(existing.modderId, 'chat:status', { chatId: id, status });

      res.json(chat);
    } catch (err) {
      console.error('[PUT /chats/:id/status]', err);
      res.status(500).json({ error: 'Failed to update chat status' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH-REQUIRED ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST / — Initiate a chat for a paid mod.
 *
 * - Creates a new chat between the buyer and the mod author.
 * - If a chat already exists for this user + mod, returns the existing one.
 * - Sends a real-time notification and email to the modder.
 */
router.post(
  '/',
  validate({ body: initiateChatSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.user!;
      const { modId, message } = req.body as z.infer<typeof initiateChatSchema>;

      // ── Validate mod exists and is eligible for chat ────────────────
      const mod = await prisma.mod.findUnique({
        where: { id: modId },
        include: {
          author: {
            select: { ...chatUserSelect, email: true },
          },
        },
      });

      if (!mod || mod.status !== 'published') {
        res.status(404).json({ error: 'Mod not found' });
        return;
      }

      if (mod.accessType !== 'paid') {
        res.status(400).json({ error: 'Chat is only available for paid mods' });
        return;
      }

      // Cannot initiate a chat with yourself
      if (mod.authorId === user.id) {
        res
          .status(400)
          .json({ error: 'You cannot initiate a chat on your own mod' });
        return;
      }

      // ── Check for existing chat ─────────────────────────────────────
      const existingChat = await prisma.chat.findUnique({
        where: { modId_buyerId: { modId, buyerId: user.id } },
        include: {
          mod: { select: chatModSelect },
          buyer: { select: chatUserSelect },
          modder: { select: chatUserSelect },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 50,
            include: { sender: { select: chatUserSelect } },
          },
        },
      });

      if (existingChat) {
        res.json({ chat: existingChat, existing: true });
        return;
      }

      // ── Create the chat + first message in a transaction ────────────
      const chatId = await prisma.$transaction(async (tx: any) => {
        const newChat = await tx.chat.create({
          data: {
            modId,
            buyerId: user.id,
            modderId: mod.authorId,
          },
        });

        await tx.chatMessage.create({
          data: {
            chatId: newChat.id,
            senderId: user.id,
            content: message,
          },
        });

        return newChat.id;
      });

      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        include: {
          mod: { select: chatModSelect },
          buyer: { select: chatUserSelect },
          modder: { select: chatUserSelect },
          messages: {
            orderBy: { createdAt: 'asc' },
            include: { sender: { select: chatUserSelect } },
          },
        },
      });

      if (!chat) {
        res.status(500).json({ error: 'Chat creation failed' });
        return;
      }

      // ── Join both users to the Socket.IO room ───────────────────────
      emitToUser(user.id, 'chat:join', { chatId: chat.id });
      emitToUser(mod.authorId, 'chat:join', { chatId: chat.id });

      // ── Notify the modder ───────────────────────────────────────────
      const notification = await prisma.notification.create({
        data: {
          userId: mod.authorId,
          type: 'chat',
          title: 'New Chat Message',
          message: `${user.username} wants to discuss "${mod.title}"`,
          link: `/chats/${chat.id}`,
        },
      });

      emitToUser(mod.authorId, 'notification:new', notification);

      // ── Log chat activity ───────────────────────────────────────────
      await prisma.activityLog.create({
        data: {
          type: 'chat',
          message: `${user.username} started a chat about "${mod.title}"`,
          userId: user.id,
          metadata: { chatId: chat.id, modId },
        },
      });

      // ── Send email notification (fire & forget) ─────────────────────
      sendChatNotification(
        mod.author.email,
        user.username,
        mod.title,
      ).catch(() => {});

      res.status(201).json({ chat, existing: false });
    } catch (err) {
      console.error('[POST /chats]', err);
      res.status(500).json({ error: 'Failed to initiate chat' });
    }
  },
);

/**
 * GET / — List all chats for the authenticated user.
 *
 * Returns chats where the user is either the buyer or the modder, including
 * the last message and unread count. Sorted by most recent activity.
 */
router.get(
  '/',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.id;

      const chats = await prisma.chat.findMany({
        where: {
          OR: [{ buyerId: userId }, { modderId: userId }],
        },
        include: {
          mod: { select: chatModSelect },
          buyer: { select: chatUserSelect },
          modder: { select: chatUserSelect },
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              id: true,
              content: true,
              imageUrl: true,
              senderId: true,
              createdAt: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      // Compute unread count for each chat and flatten the last message
      const chatsWithMeta = await Promise.all(
        chats.map(async (chat: typeof chats[number]) => {
          const unreadCount = await prisma.chatMessage.count({
            where: {
              chatId: chat.id,
              senderId: { not: userId },
              isRead: false,
            },
          });

          return {
            id: chat.id,
            modId: chat.modId,
            status: chat.status,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            mod: chat.mod,
            // Show the "other" user's info prominently
            otherUser:
              chat.buyerId === userId ? chat.modder : chat.buyer,
            buyer: chat.buyer,
            modder: chat.modder,
            lastMessage: chat.messages[0] ?? null,
            unreadCount,
          };
        }),
      );

      res.json({ chats: chatsWithMeta });
    } catch (err) {
      console.error('[GET /chats]', err);
      res.status(500).json({ error: 'Failed to fetch chats' });
    }
  },
);

/**
 * GET /:id — Get a single chat with paginated messages.
 *
 * - Verifies the user is a participant (buyer or modder) or an admin.
 * - Marks all unread messages from the other user as read.
 * - Returns paginated messages (default 50 per page, newest first).
 */
router.get(
  '/:id',
  validate({ query: paginationQuery }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Chat ID is required' });
        return;
      }
      const user = req.user!;
      const { page, limit } =
        (res.locals.validated?.query ?? req.query) as z.infer<typeof paginationQuery>;

      // ── Fetch chat with relations ───────────────────────────────────
      const chat = await prisma.chat.findUnique({
        where: { id },
        include: {
          mod: { select: chatModSelect },
          buyer: { select: chatUserSelect },
          modder: { select: chatUserSelect },
        },
      });

      if (!chat) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      // ── Authorization: participant or admin ─────────────────────────
      const isParticipant =
        chat.buyerId === user.id || chat.modderId === user.id;
      const isAdmin = user.role === 'admin' || user.role === 'owner';

      if (!isParticipant && !isAdmin) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // ── Mark unread messages from the other user as read ────────────
      if (isParticipant) {
        await prisma.chatMessage.updateMany({
          where: {
            chatId: id,
            senderId: { not: user.id },
            isRead: false,
          },
          data: { isRead: true },
        });

        // Notify the other user that messages were read
        const otherUserId =
          chat.buyerId === user.id ? chat.modderId : chat.buyerId;
        emitToRoom(`chat:${id}`, 'chat:read', {
          chatId: id,
          readBy: user.id,
        });
        emitToUser(otherUserId, 'chat:unread_update', { chatId: id });
      }

      // ── Paginated messages ──────────────────────────────────────────
      const skip = (page - 1) * limit;

      const [messages, total] = await Promise.all([
        prisma.chatMessage.findMany({
          where: { chatId: id },
          include: { sender: { select: chatUserSelect } },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.chatMessage.count({ where: { chatId: id } }),
      ]);

      res.json({
        chat,
        messages: messages.reverse(), // Return in chronological order
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error('[GET /chats/:id]', err);
      res.status(500).json({ error: 'Failed to fetch chat' });
    }
  },
);

/**
 * POST /:id/messages — Send a text message in a chat.
 *
 * - Verifies the user is a participant.
 * - Creates the message, emits it via Socket.IO, and notifies the recipient.
 */
router.post(
  '/:id/messages',
  validate({ body: sendMessageSchema }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Chat ID is required' });
        return;
      }
      const user = req.user!;
      const { content } = req.body as z.infer<typeof sendMessageSchema>;

      // ── Fetch chat and verify participation ─────────────────────────
      const chat = await prisma.chat.findUnique({
        where: { id },
        include: {
          mod: { select: { title: true } },
        },
      });

      if (!chat) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      if (chat.buyerId !== user.id && chat.modderId !== user.id) {
        res.status(403).json({ error: 'You are not a participant of this chat' });
        return;
      }

      // ── Create the message ──────────────────────────────────────────
      const message = await prisma.chatMessage.create({
        data: {
          chatId: id,
          senderId: user.id,
          content,
        },
        include: { sender: { select: chatUserSelect } },
      });

      // Touch the chat's updatedAt timestamp
      await prisma.chat.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      // ── Emit to chat room via Socket.IO ─────────────────────────────
      emitToRoom(`chat:${id}`, 'chat:message', message);

      // ── Notify the other user ───────────────────────────────────────
      const recipientId =
        chat.buyerId === user.id ? chat.modderId : chat.buyerId;

      // Always emit notification to the recipient's personal room;
      // the client de-dupes if they're already viewing the chat.
      const notification = await prisma.notification.create({
        data: {
          userId: recipientId,
          type: 'chat',
          title: 'New Message',
          message: `${user.username}: ${content.slice(0, 100)}${content.length > 100 ? '…' : ''}`,
          link: `/chats/${id}`,
        },
      });

      emitToUser(recipientId, 'notification:new', notification);

      res.status(201).json(message);
    } catch (err) {
      console.error('[POST /chats/:id/messages]', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  },
);

/**
 * POST /:id/image — Send an image message in a chat.
 *
 * Uses the `uploadChatImage` Multer middleware to handle the file upload.
 * The image is stored at `/uploads/chat/{filename}`.
 */
router.post(
  '/:id/image',
  uploadChatImage,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = getParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'Chat ID is required' });
        return;
      }
      const user = req.user!;

      // ── Validate upload ─────────────────────────────────────────────
      if (!req.file) {
        res.status(400).json({ error: 'No image file provided' });
        return;
      }

      // ── Fetch chat and verify participation ─────────────────────────
      const chat = await prisma.chat.findUnique({
        where: { id },
        include: {
          mod: { select: { title: true } },
        },
      });

      if (!chat) {
        res.status(404).json({ error: 'Chat not found' });
        return;
      }

      if (chat.buyerId !== user.id && chat.modderId !== user.id) {
        res.status(403).json({ error: 'You are not a participant of this chat' });
        return;
      }

      // ── Create image message ────────────────────────────────────────
      const imageUrl = `/uploads/chat/${req.file.filename}`;

      const message = await prisma.chatMessage.create({
        data: {
          chatId: id,
          senderId: user.id,
          imageUrl,
        },
        include: { sender: { select: chatUserSelect } },
      });

      // Touch the chat's updatedAt timestamp
      await prisma.chat.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      // ── Emit to chat room via Socket.IO ─────────────────────────────
      emitToRoom(`chat:${id}`, 'chat:message', message);

      // ── Notify the other user ───────────────────────────────────────
      const recipientId =
        chat.buyerId === user.id ? chat.modderId : chat.buyerId;

      const notification = await prisma.notification.create({
        data: {
          userId: recipientId,
          type: 'chat',
          title: 'New Image',
          message: `${user.username} sent an image`,
          link: `/chats/${id}`,
        },
      });

      emitToUser(recipientId, 'notification:new', notification);

      res.status(201).json(message);
    } catch (err) {
      console.error('[POST /chats/:id/image]', err);
      res.status(500).json({ error: 'Failed to send image' });
    }
  },
);

// =============================================================================

export default router;
