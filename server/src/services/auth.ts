/** Password hashing and JWT issuing/verification. */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const SALT_ROUNDS = 12;

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded === 'string' || !decoded.sub) {
    throw new Error('Malformed token payload.');
  }
  return { sub: String(decoded.sub), email: String(decoded.email ?? ''), name: String(decoded.name ?? '') };
}

/** Extract a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length < 2) return null;
  if (parts[0]!.toLowerCase() !== 'bearer') return null;
  return parts[1]!.trim() || null;
}