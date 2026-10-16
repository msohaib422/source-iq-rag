/**
 * Responsive layout checks.
 * Runs on the mobile-chromium project (Pixel 7 viewport) as configured in
 * playwright.config.ts, and verifies the desktop layout in the same file.
 */
import { expect, test } from '@playwright/test';
import { goTo, navLink, signIn, uploadFixture } from './helpers.js';

test.describe('responsive layout', () => {
  test('renders without horizontal overflow and keeps controls reachable', async ({ page }) => {
    await page.goto('/');
    await signIn(page);
    await goTo(page, 'Documents');
    await uploadFixture(page);

    // No element may push the viewport wider than the screen.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);

    const uploadZone = page.getByTestId('upload-zone');
    await expect(uploadZone).toBeVisible();
    const box = await uploadZone.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });

  test('chat composer and messages stay usable on a narrow viewport', async ({ page }) => {
    await page.goto('/');
    await signIn(page);
    await goTo(page, 'Documents');
    await uploadFixture(page);
    await goTo(page, 'Chat');

    const input = page.getByTestId('chat-input');
    await expect(input).toBeVisible();
    const box = await input.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

    await input.fill('What fed Lake Chad?');
    await input.press('Enter');
    await expect(page.getByTestId('message-assistant').last()).toBeVisible({ timeout: 120_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('navigation stays reachable across breakpoints', async ({ page }) => {
    await page.goto('/');
    // The nav bar is administrative: sign in before asserting on it.
    await signIn(page);
    for (const width of [360, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(navLink(page, 'Documents')).toBeVisible();
      await expect(navLink(page, 'Chat')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
});