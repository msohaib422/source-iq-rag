/**
 * Shared helpers for the browser end-to-end suite.
 *
 * The fixture PDF is generated in-process so the tests have a guaranteed,
 * known-content document to ask questions about — no binary fixtures needed.
 */
import { expect, type Page } from '@playwright/test';

export function buildPdf(lines: string[]): Buffer {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = ['BT', '/F1 12 Tf', '72 720 Td', '14 TL', ...lines.map((l) => `(${escape(l)}) Tj T*`), 'ET'].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export const RESEARCH_PDF_LINES = [
  'SourceIQ End-to-End Fixture: Hydrology of Lake Chad',
  '',
  'Lake Chad lost ninety percent of its surface area between 1960 and 2000.',
  'The lake is fed principally by the Chari and Logone rivers.',
  'Surface area declined from approximately 25000 square kilometres to 1500.',
  '',
  'Sahel drought reduced river inflow by roughly forty percent during the 1970s.',
  'Large-scale irrigation withdrawals near Maiduguri compounded the loss.',
  '',
  'The Lake Chad Basin Commission was established in 1964 to coordinate management.',
  'A regional strategy adopted in 2011 aimed to transfer 40 percent of inflows.',
  'Wetland restoration at the Waza_LOGone floodplain showed measurable recovery.',
  '',
  'Sediment deposits now expose the shrinkage of the lake to seasonal flooding.',
  'Groundwater in the basin supports roughly 40 percent of regional irrigation.',
];

/**
 * Scoped navigation helpers.
 *
 * The admin header nav and the page body can both link to /admin/documents, so
 * navigation is always scoped to the nav bar rather than matched by accessible
 * name alone. The public chat has no nav bar at all.
 */
export function navLink(page: Page, name: 'Dashboard' | 'Documents' | 'Chat') {
  return page.locator('.app-nav').getByRole('link', { name, exact: true });
}

export async function goTo(page: Page, name: 'Dashboard' | 'Documents' | 'Chat'): Promise<void> {
  await navLink(page, name).click();
}

/**
 * Admin credentials for the sign-in flow. Must match the ADMIN_EMAIL /
 * ADMIN_PASSWORD passed to the API web server in playwright.config.ts.
 */
export const ADMIN_EMAIL = 'admin@gmail.com';
export const ADMIN_PASSWORD = '12345678';

/** Sign in as the admin; authentication switches the app to the dashboard. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
}

/** Sign the admin out; the app returns to the minimal public chat. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/($|chat)/);
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

/**
 * Upload the fixture PDF and wait until this upload's row reports "Indexed".
 *
 * Each call gets a unique filename so the helper can wait for its own new row
 * instead of matching a pre-existing fixture row (all fixtures share content
 * but their titles must be distinguishable for scoping assertions).
 * Returns the document title the server derived from the filename.
 */
export async function uploadFixture(page: Page, filename?: string): Promise<string> {
  const name =
    filename ?? `lake-chad-fixture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.pdf`;
  const pdf = buildPdf(RESEARCH_PDF_LINES);
  await page.getByTestId('upload-zone').click();
  await page.getByTestId('file-input').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: pdf,
  });

  // Mirror the server's title derivation (routes/documents.ts) so the wait is
  // scoped to this upload.
  const title = name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  const row = page.getByTestId('document-row').filter({ hasText: title });
  await expect(row).toHaveCount(1, { timeout: 120_000 });

  // The server extracts, chunks and embeds before responding, so this is a real
  // end-to-end wait rather than a fixed sleep.
  await expect(row.first().getByText('Indexed')).toBeVisible({ timeout: 120_000 });
  return title;
}