import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Request } from 'express';

// ---------------------------------------------------------------------------
// Allowed MIME types
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Storage factory
// ---------------------------------------------------------------------------

/**
 * Create a Multer disk storage engine that saves files into the given
 * subdirectory under `uploads/`, using a UUID-based filename to avoid
 * collisions.
 */
function createStorage(subDir: string) {
  return multer.diskStorage({
    destination: (_req: Request, _file, cb) => {
      cb(null, path.join(process.cwd(), 'uploads', subDir));
    },
    filename: (_req: Request, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  });
}

// ---------------------------------------------------------------------------
// File filter
// ---------------------------------------------------------------------------

const imageFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpeg, png, gif, webp) are allowed'));
  }
};

// ---------------------------------------------------------------------------
// Pre-configured Multer instances
// ---------------------------------------------------------------------------

/**
 * Upload middleware for user avatars.
 * Expects a single file under the field name `avatar`.
 */
export const uploadAvatar = multer({
  storage: createStorage('avatars'),
  fileFilter: imageFilter,
  limits: { fileSize: MAX_FILE_SIZE },
}).single('avatar');

/**
 * Upload middleware for chat images.
 * Expects a single file under the field name `image`.
 */
export const uploadChatImage = multer({
  storage: createStorage('chat'),
  fileFilter: imageFilter,
  limits: { fileSize: MAX_FILE_SIZE },
}).single('image');

/**
 * Upload middleware for mod icons.
 * Expects a single file under the field name `icon`.
 */
export const uploadModIcon = multer({
  storage: createStorage('mods/icons'),
  fileFilter: imageFilter,
  limits: { fileSize: MAX_FILE_SIZE },
}).single('icon');

/**
 * Upload middleware for mod gallery images.
 * Expects up to 10 files under the field name `gallery`.
 */
export const uploadModGallery = multer({
  storage: createStorage('mods/gallery'),
  fileFilter: imageFilter,
  limits: { fileSize: MAX_FILE_SIZE },
}).array('gallery', 10);
