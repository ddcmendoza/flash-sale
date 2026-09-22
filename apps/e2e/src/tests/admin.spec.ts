import { randomUUID } from 'node:crypto';
import { expect, test } from '../fixtures';
import { purchase } from '../helpers/api';
import { groundTruth } from '../helpers/db';

test.describe('admin page', () => {
  test('create → edit → purchases → delete leaves nothing behind', async ({ page }) => {
    const saleId = `e2e-admin-${randomUUID().slice(0, 6)}`;
    const saleName = `E2E Admin ${randomUUID().slice(0, 4)}`;
    page.on('dialog', (dialog) => void dialog.accept());

    await page.goto('/#/admin');

    // Create a sale entirely through the UI form (window defaults are live).
    await page.locator('.admin-form input').nth(0).fill(saleId);
    await page.locator('.admin-form label', { hasText: 'Name' }).locator('input').fill(saleName);
    await page.locator('.admin-form label', { hasText: 'Price' }).locator('input').fill('12.34');
    await page.locator('.admin-form label', { hasText: 'Quantity' }).locator('input').fill('10');
    await page.getByRole('button', { name: 'Create sale' }).click();

    await expect(page.locator('.msg')).toContainText(`Created '${saleName}'.`);
    const row = page.locator('.admin-table tbody tr', { hasText: saleId });
    await expect(row).toBeVisible();
    await expect(row).toContainText('$12.34');
    await expect(row).toContainText('0/10 sold');

    // Edit (rename) via the prefilled form.
    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('.admin-form h2')).toHaveText(`Edit: ${saleId}`);
    await expect(page.locator('.admin-form input').nth(0)).toBeDisabled();
    await page.locator('.admin-form label', { hasText: 'Name' }).locator('input').fill(`${saleName} v2`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.msg')).toContainText(`Updated '${saleName} v2'.`);

    // Purchases (made over the API) are inspectable in the admin table panel.
    await purchase(saleId, 'admin-viewer-1');
    await purchase(saleId, 'admin-viewer-2');
    await row.getByRole('button', { name: 'Purchases' }).click();
    const panel = page.locator('.card', { hasText: `Purchases · ${saleId}` });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('2 rows (newest first)');
    await expect(panel).toContainText('admin-viewer-1');
    await expect(panel).toContainText('admin-viewer-2');

    // Delete with confirmation: sale and its purchases vanish.
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.msg')).toContainText(`Deleted '${saleName} v2'.`);
    await expect(row).toHaveCount(0);
    await expect(panel).toHaveCount(0);
  });

  test('reset wipes purchases and re-arms stock (ground truth in DB)', async ({
    page,
    makeSale,
  }) => {
    const sale = await makeSale({
      name: 'E2E Admin Reset',
      totalQuantity: 30,
      priceCents: 9900,
    });
    await purchase(sale.id, 'reset-buyer');
    await purchase(sale.id, 'reset-buyer-2');
    await expect.poll(async () => (await groundTruth(sale.id)).purchaseRows).toBe(2);

    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto('/#/admin');
    const row = page.locator('.admin-table tbody tr', { hasText: sale.id });
    await expect(row).toContainText('2/30 sold');

    await row.getByRole('button', { name: 'Reset' }).click();
    await expect(page.locator('.msg')).toContainText('re-armed (30 in stock)');
    await expect(row).toContainText('0/30 sold');

    await expect.poll(async () => (await groundTruth(sale.id)).purchaseRows).toBe(0);
  });

  test('form validation rejects bad input', async ({ page }) => {
    await page.goto('/#/admin');
    const form = page.locator('.admin-form');

    await page.getByRole('button', { name: 'Create sale' }).click();
    await expect(page.locator('.msg')).toContainText('Name is required.');

    await form.locator('label', { hasText: 'Name' }).locator('input').fill('E2E Bad Price');
    await form.locator('label', { hasText: 'Price' }).locator('input').fill('0');
    await page.getByRole('button', { name: 'Create sale' }).click();
    await expect(page.locator('.msg')).toContainText('Enter a valid price greater than 0.');

    await form.locator('label', { hasText: 'Price' }).locator('input').fill('1');
    await form.locator('label', { hasText: 'Quantity' }).locator('input').fill('50');
    await form.locator('label', { hasText: 'Starts at' }).locator('input').fill('2026-01-02T12:00');
    await form.locator('label', { hasText: 'Ends at' }).locator('input').fill('2026-01-01T12:00');
    await page.getByRole('button', { name: 'Create sale' }).click();
    await expect(page.locator('.msg')).toContainText('End must be after start.');
  });
});