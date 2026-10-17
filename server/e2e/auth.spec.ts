/** Authentication, session and access-control coverage in the browser. */
import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, buildPdf, goTo, signIn, signOut } from './helpers.js';

test.describe('authentication and access control', () => {
  test('rejects invalid credentials with a visible error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toContainText(/incorrect email or password/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('serves anonymous visitors a chat-only interface', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    // No administrative or technical surface for anonymous visitors.
    await expect(page.locator('.app-nav')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Documents' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Scope' })).toHaveCount(0);
    await expect(page.getByText('Indexed chunks')).toHaveCount(0);
    await expect(page.getByText(/BAAI\/bge-small-en-v1\.5/)).toHaveCount(0);
    await expect(page.getByTestId('upload-zone')).toHaveCount(0);

    // The only admin affordance is the sign-in entry point.
    await expect(page.getByRole('link', { name: 'Admin sign in' })).toBeVisible();

    // /chat is the same public experience, with no redirect to /login.
    await page.goto('/chat');
    await expect(page.getByTestId('chat-input')).toBeVisible();
  });

  test('keeps administrative routes out of reach for anonymous visitors', async ({ page }) => {
    for (const path of ['/admin', '/admin/documents', '/admin/documents/000000000000000000000000']) {
      await page.goto(path);
      // No session and no expired token: the visitor is sent to the public chat,
      // never to the administrative interface.
      await expect(page).toHaveURL(/\/($|chat)/);
      await expect(page.getByTestId('chat-input')).toBeVisible();
      await expect(page.locator('.app-nav')).toHaveCount(0);
    }
  });

  test('rejects every anonymous management attempt on the server', async ({ page }) => {
    // The browser context holds no admin token: enforcement must be server-side.
    const missing = '000000000000000000000000';

    const upload = await page.request.post('/api/documents', {
      multipart: {
        file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: buildPdf(['classified']) },
      },
    });
    expect(upload.status()).toBe(401);

    expect((await page.request.patch(`/api/documents/${missing}`, { data: { title: 'x' } })).status()).toBe(401);
    expect((await page.request.post(`/api/documents/${missing}/reindex`, { data: {} })).status()).toBe(401);
    expect((await page.request.delete(`/api/documents/${missing}`)).status()).toBe(401);
    expect((await page.request.patch(`/api/chunks/${missing}`, { data: { text: 'x' } })).status()).toBe(401);
    expect((await page.request.delete(`/api/chunks/${missing}`)).status()).toBe(401);

    // Queries Management is admin-only too: no list, indexing or delete for visitors.
    expect((await page.request.get('/api/queries')).status()).toBe(401);
    expect((await page.request.post(`/api/queries/${missing}/indexed`)).status()).toBe(401);
    expect((await page.request.delete(`/api/queries/${missing}`)).status()).toBe(401);
  });

  test('has no public registration route', async ({ page }) => {
    await page.goto('/register');
    // Unknown routes fall through to the public chat — no sign-up form.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Welcome/i })).toHaveCount(0);
  });

  test('restores the admin session after reload', async ({ page }) => {
    await signIn(page);
    await goTo(page, 'Documents');
    await expect(page).toHaveURL(/\/admin\/documents/);

    await page.reload();
    await expect(page).toHaveURL(/\/admin\/documents/);
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('signs out and returns to anonymous use', async ({ page }) => {
    await signIn(page);
    await signOut(page);

    // The public chat is the landing page again, with no admin chrome.
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.locator('.app-nav')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);

    // Administrative routes are closed again.
    await page.goto('/admin/documents');
    await expect(page).toHaveURL(/\/($|chat)/);
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.locator('.app-nav')).toHaveCount(0);
  });

  test('offers re-authentication when a stored admin session is rejected', async ({ page }) => {
    await page.goto('/');
    // A stored token the server will not accept (expired or tampered with).
    await page.evaluate(() => window.localStorage.setItem('sourceiq.token', 'not-a-valid-token'));
    await page.goto('/admin');

    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/admin/);
    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
  });

  test('surfaces an API outage instead of hanging', async ({ page }) => {
    await signIn(page);
    // Break the API and force a request.
    await page.route('**/api/documents**', (route) => route.abort('failed'));
    await page.goto('/admin/documents');
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 30_000 });
  });
});
