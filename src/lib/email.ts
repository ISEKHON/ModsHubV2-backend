import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';

// ---------------------------------------------------------------------------
// Transporter setup
// ---------------------------------------------------------------------------

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false, // true for 465, false for other ports (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM_ADDRESS = `"FS Mods Hub" <${process.env.SMTP_USER || 'noreply@fsmodshub.com'}>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Internal send wrapper — logs errors but never throws so email failures
 * don't crash the application.
 */
async function safeSend(options: Mail.Options): Promise<void> {
  try {
    await transporter.sendMail({ from: FROM_ADDRESS, ...options });
  } catch (err) {
    console.error('[EMAIL] Failed to send email:', err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notify a user that their account has been banned.
 */
export async function sendBanNotice(to: string, reason: string): Promise<void> {
  await safeSend({
    to,
    subject: 'FS Mods Hub — Account Banned',
    html: `
      <h2>Your account has been banned</h2>
      <p><strong>Reason:</strong> ${reason}</p>
      <p>If you believe this is a mistake, please contact support.</p>
    `,
  });
}

/**
 * Notify a user about a new chat message.
 */
export async function sendChatNotification(
  to: string,
  senderName: string,
  modTitle: string,
): Promise<void> {
  await safeSend({
    to,
    subject: `FS Mods Hub — New message about "${modTitle}"`,
    html: `
      <h2>New Chat Message</h2>
      <p><strong>${senderName}</strong> sent you a message about <em>${modTitle}</em>.</p>
      <p>Log in to view and reply.</p>
    `,
  });
}

/**
 * Notify a user that their mod has been approved.
 */
export async function sendModApproved(to: string, modTitle: string): Promise<void> {
  await safeSend({
    to,
    subject: `FS Mods Hub — Mod Approved: "${modTitle}"`,
    html: `
      <h2>Your mod has been approved! 🎉</h2>
      <p><strong>${modTitle}</strong> is now live on FS Mods Hub.</p>
    `,
  });
}

/**
 * Alert admins/moderators about a reported mod.
 */
export async function sendReportAlert(
  to: string[],
  modTitle: string,
  reason: string,
): Promise<void> {
  await safeSend({
    to: to.join(', '),
    subject: `FS Mods Hub — Mod Reported: "${modTitle}"`,
    html: `
      <h2>Mod Report</h2>
      <p>The mod <strong>${modTitle}</strong> has been reported.</p>
      <p><strong>Reason:</strong> ${reason}</p>
      <p>Please review it in the admin dashboard.</p>
    `,
  });
}
