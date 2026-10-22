import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireAuth, validate } from '../middleware/index.js';
import { hashPassword, signToken, verifyPassword } from '../services/auth.js';
import { conflict, unauthorized } from '../utils/errors.js';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.').max(128),
});

export const authRouter = Router();

// There is no public registration route by design: the app is usable without an
// account, and the single admin account is provisioned from the environment
// (see services/accounts.ts).
authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;

    const user = await req.ctx.store.findUserByEmail(email);
    // Constant-ish work whether or not the user exists, to blunt timing attacks.
    const hash = user?.passwordHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await verifyPassword(password, hash);

    // Only the admin can sign in; regular/legacy accounts are never issued a token.
    if (!user || !ok || user.role !== 'admin') throw unauthorized('Incorrect email or password.');

    const token = signToken({ sub: user.id, email: user.email, name: user.name });
    res.json({ token, user: publicUser(user) });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user!) });
  }),
);

const updateProfileSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100).optional(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional(),
}).refine((v) => v.name !== undefined || v.email !== undefined, {
  message: 'Provide a name or email to update.',
});

authRouter.patch(
  '/me',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const { name, email } = req.body as z.infer<typeof updateProfileSchema>;
    const user = req.user!;

    if (email && email !== user.email) {
      const existing = await req.ctx.store.findUserByEmail(email);
      if (existing && existing.id !== user.id) throw conflict('That email is already in use.');
    }

    const updated = await req.ctx.store.updateUser(user.id, {
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    });
    if (!updated) throw unauthorized('Account no longer exists.');
    res.json({ user: publicUser(updated) });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.').max(128),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.').max(128),
});

authRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
    const user = req.user!;

    const full = await req.ctx.store.findUserById(user.id);
    if (!full) throw unauthorized('Account no longer exists.');

    const ok = await verifyPassword(currentPassword, full.passwordHash);
    if (!ok) throw unauthorized('Current password is incorrect.');

    const passwordHash = await hashPassword(newPassword);
    const updated = await req.ctx.store.updateUser(user.id, { passwordHash });
    if (!updated) throw unauthorized('Account no longer exists.');
    res.status(204).end();
  }),
);

function publicUser(user: { id: string; email: string; name: string; role: string; createdAt: Date }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt };
}
