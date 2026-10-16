import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireAuth, validate } from '../middleware/index.js';
import { signToken, verifyPassword } from '../services/auth.js';
import { unauthorized } from '../utils/errors.js';

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

function publicUser(user: { id: string; email: string; name: string; role: string; createdAt: Date }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt };
}
