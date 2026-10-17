/**
 * Queries Management in the browser.
 *
 * The full feature flow: the dashboard Queries card counts unanswered chat
 * questions and opens the management page; answerable questions are never
 * recorded while unanswerable ones land in Pending; clicking Indexed moves a
 * record to Indexed (persisted across reloads) and deleting removes exactly
 * that record; the Queries navigation item works and the navigation stays
 * visible on the admin Chat page.
 */
import { expect, test } from '@playwright/test';
import { goTo, navLink, signIn, uploadFixture } from './helpers.js';

test.describe('Queries Management', () => {
  test('collects only unanswered questions, then indexes and deletes them', async ({ page }) => {
    await page.goto('/');
    await signIn(page);

    // Index the fixture so its question has a real answer.
    await goTo(page, 'Documents');
    await uploadFixture(page);

    // Ask a question the knowledge base answers ...
    await goTo(page, 'Chat');
    await page.getByTestId('chat-input').fill('Why did Lake Chad lose so much of its surface area?');
    await page.getByTestId('chat-input').press('Enter');
    const answer = page.getByTestId('message-assistant').last();
    await expect(answer).toBeVisible({ timeout: 120_000 });
    await expect(answer.getByTestId('citation').first()).toBeVisible({ timeout: 120_000 });

    // ... and one it cannot answer.
    await page.getByTestId('chat-input').fill('Who won the 1966 FIFA World Cup?');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('message-assistant').nth(1)).toBeVisible({ timeout: 120_000 });

    // The dashboard Queries card counts exactly the unanswered one (1) and
    // opens the Queries Management page.
    await navLink(page, 'Dashboard').click();
    const card = page.locator('a.stat-card').filter({ hasText: 'Queries' });
    await expect(card.locator('.stat-value')).toHaveText('1');
    await card.click();
    await expect(page).toHaveURL(/\/admin\/queries/);

    // Pending holds the question with its exact submitted text; nothing is
    // recorded for the answerable question.
    await expect(page.getByTestId('pending-count')).toHaveText('1');
    await expect(page.getByTestId('indexed-count')).toHaveText('0');
    const row = page.getByTestId('query-row').filter({ hasText: 'Who won the 1966 FIFA World Cup?' });
    await expect(row).toHaveCount(1);

    // Indexed: the button marks the record without any editing step.
    await row.getByTestId('query-indexed').click();

    // The record moves Pending -> Indexed immediately, keeping its exact text.
    await expect(page.getByTestId('pending-count')).toHaveText('0');
    await expect(page.getByTestId('indexed-count')).toHaveText('1');
    const indexedRow = page.getByTestId('query-row').filter({
      hasText: 'Who won the 1966 FIFA World Cup?',
    });
    await expect(indexedRow).toHaveCount(1);

    // The status change is persisted: after a reload it is still in Indexed.
    await page.reload();
    await expect(page.getByTestId('indexed-count')).toHaveText('1');
    await expect(page.getByTestId('pending-count')).toHaveText('0');

    // The dashboard card follows the pending total.
    await navLink(page, 'Dashboard').click();
    await expect(page.locator('a.stat-card').filter({ hasText: 'Queries' }).locator('.stat-value')).toHaveText('0');

    // A second unanswered question can then be deleted, and only that record
    // disappears.
    await goTo(page, 'Chat');
    await page.getByTestId('chat-input').fill('What is the tallest mountain in the solar system?');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('message-assistant').last()).toBeVisible({ timeout: 120_000 });

    await navLink(page, 'Queries').click();
    await expect(page.getByTestId('pending-count')).toHaveText('1');
    await expect(page.getByTestId('indexed-count')).toHaveText('1');

    const pending2 = page
      .getByTestId('query-row')
      .filter({ hasText: 'What is the tallest mountain in the solar system?' });
    await expect(pending2).toHaveCount(1);
    await pending2.getByTestId('query-delete').click();
    // Two-step confirmation guards the destructive action: arm, then confirm.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: /Click again to delete/i }).click();

    await expect(page.getByTestId('pending-count')).toHaveText('0');
    await expect(page.getByTestId('indexed-count')).toHaveText('1');
    await expect(page.getByTestId('query-row').filter({
      hasText: 'Who won the 1966 FIFA World Cup?',
    })).toHaveCount(1);
    await expect(pending2).toHaveCount(0);
  });

  test('navigation shows Queries and stays visible on the Chat page', async ({ page }) => {
    await page.goto('/');
    await signIn(page);

    for (const name of ['Dashboard', 'Documents', 'Queries', 'Chat'] as const) {
      await expect(navLink(page, name)).toBeVisible();
    }

    // The Chat page keeps the administrative navigation; Chat is highlighted.
    await goTo(page, 'Chat');
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.locator('.app-nav')).toBeVisible();
    await expect(navLink(page, 'Chat')).toHaveClass(/active/);
    await expect(navLink(page, 'Dashboard')).not.toHaveClass(/active/);

    // Queries opens its page and is highlighted there.
    await navLink(page, 'Queries').click();
    await expect(page).toHaveURL(/\/admin\/queries/);
    await expect(page.getByRole('heading', { name: 'Queries' })).toBeVisible();
    await expect(navLink(page, 'Queries')).toHaveClass(/active/);
  });
});