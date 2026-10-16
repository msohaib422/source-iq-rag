/**
 * Account provisioning for the admin-only authentication model.
 *
 *  - The single admin account is created from the environment on first boot
 *    (when BOOTSTRAP_ADMIN=true). There is no public registration route.
 *  - Regular users never sign in. Anonymous requests are mapped to one shared
 *    "public workspace" account so the existing per-user data scoping keeps
 *    working unchanged without any authentication requirement.
 */
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import type { Store } from '../db/store.js';
import type { UserRecord, UserRole } from '../types/domain.js';
import { hashPassword } from './auth.js';

export const PUBLIC_WORKSPACE_EMAIL = 'public-workspace@sourceiq.local';
export const PUBLIC_WORKSPACE_NAME = 'Public Workspace';

export interface AdminStatus {
  email: string;
  created: boolean;
  /** Role of the pre-existing account under ADMIN_EMAIL, when there was one. */
  existingRole?: UserRole;
}

/** Idempotently provision the admin account from the environment. */
export async function ensureAdminUser(store: Store): Promise<AdminStatus> {
  const email = env.ADMIN_EMAIL;
  const existing = await store.findUserByEmail(email);
  if (existing) {
    return { email, created: false, existingRole: existing.role };
  }

  const admin = await store.createUser({
    email,
    name: env.ADMIN_NAME,
    passwordHash: await hashPassword(env.ADMIN_PASSWORD),
    role: 'admin',
  });
  return { email: admin.email, created: true };
}

/** In-flight creation, keyed by store, so concurrent first requests create one account. */
const inFlight = new WeakMap<Store, Promise<UserRecord>>();

/**
 * Resolve the shared public workspace account, creating it on first use.
 *
 * The credential is random and discarded, so the public workspace can never be
 * signed into: only anonymous requests and the admin token get a user.
 */
export async function getOrCreatePublicWorkspaceUser(store: Store): Promise<UserRecord> {
  const existing = await store.findUserByEmail(PUBLIC_WORKSPACE_EMAIL);
  if (existing) return existing;

  let pending = inFlight.get(store);
  if (!pending) {
    pending = createPublicWorkspaceUser(store).catch((err) => {
      // Let a later request retry if creation failed.
      inFlight.delete(store);
      throw err;
    });
    inFlight.set(store, pending);
  }
  return pending;
}

async function createPublicWorkspaceUser(store: Store): Promise<UserRecord> {
  try {
    return await store.createUser({
      email: PUBLIC_WORKSPACE_EMAIL,
      name: PUBLIC_WORKSPACE_NAME,
      passwordHash: await hashPassword(randomUUID()),
      role: 'user',
    });
  } catch (err) {
    // Another process may have won the race between our lookup and the insert.
    const raced = await store.findUserByEmail(PUBLIC_WORKSPACE_EMAIL);
    if (raced) return raced;
    throw err;
  }
}

/**
 * Resolve the owner of the shared knowledge base.
 *
 * Documents and chunks belong to the public workspace account, so anonymous
 * visitors and the admin always address the same corpus: visitors retrieve
 * from it read-only, while an admin token unlocks management. The admin's own
 * account is an authentication identity only - it owns no documents.
 */
export async function resolveKnowledgeBaseId(store: Store, requester: UserRecord): Promise<string> {
  if (requester.role !== 'admin') return requester.id;
  return (await getOrCreatePublicWorkspaceUser(store)).id;
}
