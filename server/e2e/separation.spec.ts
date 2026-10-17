/**
 * Interface separation.
 *
 * Anonymous visitors get a question-and-answer chat and nothing else; the
 * signed-in admin gets the full administrative dashboard while keeping access
 * to that same chat.
 */
import { expect, test } from '@playwright/test';
import { goTo, navLink, signIn, signOut, uploadFixture } from './helpers.js';

test.describe('public chat vs admin dashboard', () => {
  test('anonymous visitors get the chat interface and nothing else', async ({ page }) => {
    await page.goto('/');

    // The chat is the landing page: input, send, messages, citations.
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByTestId('chat-messages')).toBeVisible();

    // No navigation, statistics, health, diagnostics or management.
    await expect(page.locator('.app-nav')).toHaveCount(0);
    await expect(page.getByText('Indexed chunks')).toHaveCount(0);
    await expect(page.getByText('Welcome back')).toHaveCount(0);
    await expect(page.getByText(/Datastore|Environment|LLM/)).toHaveCount(0);
    await expect(page.getByTestId('upload-zone')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Scope' })).toHaveCount(0);

    // A clearly available, but unobtrusive, admin entry point.
    await expect(page.getByRole('link', { name: 'Admin sign in' })).toBeVisible();
  });

  test('signing in switches to the full administrative dashboard', async ({ page }) => {
    await page.goto('/');
    await signIn(page);
    await expect(page).toHaveURL(/\/admin/);

    // Statistics and system diagnostics.
    await expect(page.getByText('Indexed chunks')).toBeVisible();
    await expect(page.getByText('BAAI/bge-small-en-v1.5')).toBeVisible();
    await expect(page.getByText('384 dims')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage documents' })).toBeVisible();

    // The administrative navigation exists only for the admin.
    await expect(page.locator('.app-nav')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // Document management: upload plus per-document destructive actions.
    await goTo(page, 'Documents');
    await expect(page.getByTestId('upload-zone')).toBeVisible();
    const title = await uploadFixture(page);
    const row = page.getByTestId('document-row').filter({ hasText: title }).first();
    await expect(row.getByTestId('document-delete')).toBeVisible();

    // Chunk inspection, editing and deletion.
    await row.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByTestId('document-title')).toBeVisible();
    const chunk = page.getByTestId('chunk').first();
    await expect(chunk).toBeVisible();
    await expect(chunk.getByTestId('chunk-edit')).toBeVisible();
    await expect(chunk.getByTestId('chunk-delete')).toBeVisible();
  });

  test('the admin can use the RAG chat without losing administrative access', async ({ page }) => {
    await signIn(page);
    await goTo(page, 'Chat');

    await expect(page.getByTestId('chat-input')).toBeVisible();
    // Admin-only chat affordances: library scoping, diagnostics, document links.
    await expect(page.getByRole('heading', { name: 'Scope' })).toBeVisible();
    await page.getByTestId('chat-input').fill('What fed Lake Chad?');
    await page.getByTestId('chat-input').press('Enter');
    const answer = page.getByTestId('message-assistant').last();
    await expect(answer).toBeVisible({ timeout: 120_000 });
    const citations = page.getByTestId('citation');
    if (await citations.count()) {
      await expect(citations.first().locator('.citation-score')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open in document' }).first()).toBeVisible();
    }

    // Back to the dashboard without signing in again: the primary navigation
    // stays visible on the chat page, with Chat highlighted.
    await expect(navLink(page, 'Chat')).toHaveClass(/active/);
    await navLink(page, 'Dashboard').click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
  });

  test('signing out removes the administrative interface again', async ({ page }) => {
    await signIn(page);
    await signOut(page);

    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.locator('.app-nav')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Admin sign in' })).toBeVisible();
  });

  test('a reload without a valid session falls back to the public chat', async ({ page }) => {
    await signIn(page);
    await goTo(page, 'Documents');
    await expect(page).toHaveURL(/\/admin\/documents/);

    // Drop the stored token the way an expired/invalid session would.
    await page.evaluate(() => window.localStorage.removeItem('sourceiq.token'));
    await page.reload();

    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.locator('.app-nav')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Admin sign in' })).toBeVisible();
  });
});
