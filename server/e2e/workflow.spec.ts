/**
 * The full browser-to-API workflow.
 *
 * Management (upload, re-index, chunk edit/delete, document delete) runs as the
 * signed-in admin. Retrieval is verified as anonymous visitors, who share the
 * admin-curated knowledge base but can never manage it.
 */
import { expect, test } from '@playwright/test';
import { goTo, signIn, signOut, uploadFixture } from './helpers.js';

test.describe('SourceIQ end-to-end workflow', () => {
  test('admin indexes a PDF and anonymous visitors get cited answers', async ({ page }) => {
    // ---- Opening SourceIQ lands anonymous visitors in the chat -------------
    await page.goto('/');
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.locator('.app-nav')).toHaveCount(0);
    await expect(page.getByText('Indexed chunks')).toHaveCount(0);
    await expect(page.getByText(/BAAI\/bge-small-en-v1\.5/)).toHaveCount(0);

    // ---- Upload & index (admin) --------------------------------------------
    await signIn(page);
    // Signing in switches the interface to the administrative dashboard.
    await expect(page.getByText('BAAI/bge-small-en-v1.5')).toBeVisible();
    await expect(page.getByText('384 dims')).toBeVisible();
    await expect(page.getByText('Indexed chunks')).toBeVisible();

    await goTo(page, 'Documents');
    const uploadedTitle = await uploadFixture(page);
    await expect(page.getByText(/is indexed and ready to search/i)).toBeVisible();

    const row = page.getByTestId('document-row').filter({ hasText: uploadedTitle }).first();
    await expect(row).toContainText(/\d+ chunks/);

    // ---- Signing out returns to the minimal public chat ---------------------
    await signOut(page);
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.locator('.app-nav')).toHaveCount(0);

    // ---- Ask a question without any account --------------------------------
    await page.getByTestId('chat-input').fill('Why did Lake Chad lose so much of its surface area?');
    await page.getByTestId('chat-input').press('Enter');

    // The assistant turn streams in and persists.
    const assistant = page.getByTestId('message-assistant').last();
    await expect(assistant).toBeVisible({ timeout: 120_000 });
    await expect(assistant).toContainText(/[Cc]hai|Logone|inflow|drought|irrigation/i, { timeout: 120_000 });

    // ---- Citations ---------------------------------------------------------
    const citations = page.getByTestId('citation');
    await expect(citations.first()).toBeVisible({ timeout: 60_000 });
    await expect(citations.first()).toContainText('lake chad fixture');
    // Anonymous visitors get the source passage itself, not retrieval
    // diagnostics or the administrative document view.
    await expect(citations.first().locator('.citation-score')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open in document' })).toHaveCount(0);

    // Chat holds no history: reloading starts a fresh, empty conversation.
    await page.reload();
    await expect(page.getByTestId('chat-messages')).toBeVisible();
    await expect(page.getByTestId('message-user')).toHaveCount(0);
    await expect(page.getByTestId('message-assistant')).toHaveCount(0);
    await expect(page.getByText('History')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /new conversation/i })).toHaveCount(0);
  });

  test('admin edits a chunk and anonymous retrieval reflects the change', async ({ page }) => {
    await signIn(page);
    await goTo(page, 'Documents');
    const uploadedTitle = await uploadFixture(page);

    await page
      .getByTestId('document-row')
      .filter({ hasText: uploadedTitle })
      .first()
      .getByRole('button', { name: 'Open' })
      .click();
    await expect(page.getByTestId('document-title')).toBeVisible();

    const chunk = page.getByTestId('chunk').first();
    await expect(chunk).toBeVisible();

    // Edit -> the server re-embeds the replacement text.
    await chunk.getByTestId('chunk-edit').click();
    const replacement =
      'Edited passage: the Zephyr protocol coordinates wetland restoration reviews at the Waza floodplain.';
    await chunk.getByTestId('chunk-textarea').fill(replacement);
    await chunk.getByTestId('chunk-save').click();

    await expect(page.getByText('Chunk saved and re-embedded.')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.chunk-body').first()).toContainText('Zephyr protocol');
    await expect(page.getByTestId('chunk').first().getByTestId('chunk-edited-badge')).toBeVisible();

    // Reload: the edit is persisted, not just client state.
    await page.reload();
    await expect(page.locator('.chunk-body').first()).toContainText('Zephyr protocol');

    // Anonymous retrieval now surfaces the edited passage with a citation.
    await signOut(page);
    await page.goto('/chat');
    // Source scoping is administrative, so the public chat has no library rail.
    await expect(page.getByRole('heading', { name: 'Scope' })).toHaveCount(0);
    await page.getByTestId('chat-input').fill('What does the Zephyr protocol coordinate?');
    await page.getByTestId('chat-input').press('Enter');

    const citations = page.getByTestId('citation');
    await expect(citations.first()).toBeVisible({ timeout: 120_000 });
    await expect(citations.filter({ hasText: 'Zephyr protocol' }).first()).toBeVisible({ timeout: 60_000 });
  });

  test('admin deletes a chunk and it stops being listed', async ({ page }) => {
    await signIn(page);
    await goTo(page, 'Documents');
    const uploadedTitle = await uploadFixture(page);
    await page
      .getByTestId('document-row')
      .filter({ hasText: uploadedTitle })
      .first()
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(page.getByTestId('document-title')).toBeVisible();
    const chunkCount = await page.getByTestId('chunk').count();
    expect(chunkCount).toBeGreaterThan(0);

    await page.getByTestId('chunk').first().getByTestId('chunk-delete').click();
    await expect(page.getByText('Chunk deleted and removed from the vector index.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('chunk')).toHaveCount(chunkCount - 1);
  });

  test('admin replaces a document (delete + re-upload) end to end', async ({ page }) => {
    await signIn(page);
    await goTo(page, 'Documents');
    await uploadFixture(page, 'original.pdf');

    // The knowledge base is shared across tests, so asserts are scoped to this
    // test's own document rather than counting the whole library.
    const original = page.getByTestId('document-row').filter({ hasText: 'original' });
    await expect(original).toHaveCount(1);

    // Deleting requires an explicit confirmation click (destructive-action guard).
    const row = original.first();
    await row.getByTestId('document-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /click again/i }).click();

    await expect(page.getByText('Document deleted.')).toBeVisible();
    await expect(original).toHaveCount(0);

    // Re-upload and confirm the library is usable again.
    await uploadFixture(page, 'replacement.pdf');
    await expect(page.getByTestId('document-row').filter({ hasText: 'replacement' })).toHaveCount(1);
  });

  test('scoping chat to a document restricts the sources used', async ({ page }) => {
    await signIn(page);
    await goTo(page, 'Documents');
    const uploadedTitle = await uploadFixture(page);

    // The admin uses the same chat interface, with the library scope picker.
    await goTo(page, 'Chat');
    const scope = page.getByRole('checkbox', { name: uploadedTitle });
    await expect(scope).toBeVisible();
    await scope.check();

    await page.getByTestId('chat-input').fill('What percentage of the surface area was lost?');
    await page.getByTestId('chat-input').press('Enter');

    await expect(page.getByTestId('message-assistant').last()).toBeVisible({ timeout: 120_000 });
    const citations = page.getByTestId('citation');
    await expect(citations.first()).toBeVisible({ timeout: 60_000 });
    // Every citation must come from the single selected document.
    for (const citation of await citations.all()) {
      await expect(citation).toContainText(uploadedTitle);
    }
  });
});
