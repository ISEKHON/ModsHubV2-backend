import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from './auth.js';
import { prisma } from './prisma.js';

// ---------------------------------------------------------------------------
// Module-level reference so helpers can emit without passing `io` around
// ---------------------------------------------------------------------------

let io: SocketIOServer;
const onlineUsers = new Set<string>();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Create and configure the Socket.IO server with JWT authentication
 * middleware and standard event handlers.
 */
export function setupSocketIO(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      credentials: true,
    },
  });

  // ── JWT authentication middleware ──────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const { userId } = verifyAccessToken(token);

      // Fetch user from DB to get current role
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, username: true },
      });

      if (!user) {
        return next(new Error('User not found'));
      }

      // Attach user data to the socket for later use
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const { user } = socket.data as {
      user: { id: string; role: string; username: string };
    };

    console.log(`[WS] Connected: ${user.username} (${user.id})`);

    onlineUsers.add(user.id);
    io.emit('user:presence', { userId: user.id, status: 'online' });

    // Join personal room
    socket.join(`user:${user.id}`);

    // Admins and owners get an extra room for admin-only events
    if (user.role === 'admin' || user.role === 'owner') {
      socket.join('admin');
    }

    // ── Chat events ───────────────────────────────────────────────────
    socket.on('chat:join', (payload: string | { chatId: string }) => {
      const chatId = typeof payload === 'string' ? payload : payload?.chatId;
      if (!chatId) return;
      socket.join(`chat:${chatId}`);
    });

    socket.on('presence:request', () => {
      socket.emit('presence:sync', { userIds: Array.from(onlineUsers) });
    });

    socket.on('chat:typing', (data: { chatId: string; isTyping: boolean }) => {
      socket.to(`chat:${data.chatId}`).emit('chat:typing', {
        chatId: data.chatId,
        userId: user.id,
        username: user.username,
        isTyping: data.isTyping,
      });
    });

    socket.on('chat:read', (data: { chatId: string; messageId: string }) => {
      socket.to(`chat:${data.chatId}`).emit('chat:read', {
        userId: user.id,
        messageId: data.messageId,
      });
    });

    // ── Disconnect ────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[WS] Disconnected: ${user.username} (${user.id})`);
      onlineUsers.delete(user.id);
      io.emit('user:presence', { userId: user.id, status: 'offline' });
    });
  });

  return io;
}

// ---------------------------------------------------------------------------
// Emit helpers — usable from any module after setup
// ---------------------------------------------------------------------------

/**
 * Send an event to a specific user's personal room.
 */
export function emitToUser(userId: string, event: string, data: unknown): void {
  io.to(`user:${userId}`).emit(event, data);
}

/**
 * Send an event to an arbitrary room.
 */
export function emitToRoom(room: string, event: string, data: unknown): void {
  io.to(room).emit(event, data);
}

/**
 * Send an event to all connected admins/owners.
 */
export function emitToAdmins(event: string, data: unknown): void {
  io.to('admin').emit(event, data);
}
