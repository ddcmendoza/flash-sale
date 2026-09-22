import { buyAs, checkStatus, expect, selectSale, test } from '../fixtures';
import { purchase } from '../helpers/api';
import { groundTruth } from '../helpers/db';

const DEMO_NAMES = [
  'Flash Drop — Limited Edition Watch',
  'Tech Drop — Wireless Earbuds Pro',
  'Fashion Flash — Limited Edition Sneaker',
];

test.describe('demo page', () => {
  test('renders the seeded catalog and connects to the live stream', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Flash Drop' })).toBeVisible();
    for (const name of DEMO_NAMES) {
      await expect(page.locator('.sale-chip', { hasText: name })).toBeVisible();
    }

    // A sale is auto-selected and the EventSource is live.
    await expect(page.locator('.conn')).toHaveText('● live');
    await expect(page.getByRole('button', { name: 'Buy Now' })).toBeEnabled();
  });

  test('buy is confirmed and the live SSE counter moves without reload', async ({
    page,
    makeSale,
  }) => {
    const sale = await makeSale({ name: 'E2E Buy Drop' });
    await page.goto('/');
    await selectSale(page, 'E2E Buy Drop');
    await expect(page.locator('.card-head h2')).toHaveText('E2E Buy Drop');
    await expect(page.locator('.sale-chip', { hasText: 'E2E Buy Drop' })).toContainText(
      '0/1000',
    );

    await buyAs(page, 'e2e-buyer');
    await expect(page.locator('.msg')).toContainText(
      'You got it! Your purchase is confirmed.',
    );
    await expect(page.locator('.stock-row')).toContainText('1 sold');
    await expect(page.locator('.sale-chip', { hasText: 'E2E Buy Drop' })).toContainText(
      '1/1000',
    );

    // A second user wins too; the counter keeps climbing over SSE.
    await buyAs(page, 'e2e-buyer-2');
    await expect(page.locator('.msg')).toContainText(
      'You got it! Your purchase is confirmed.',
    );
    await expect(page.locator('.stock-row')).toContainText('2 sold');

    await expect.poll(async () => (await groundTruth(sale.id)).purchaseRows).toBe(2);
  });

  test('one item per user: a repeat buyer is refused and DB agrees', async ({
    page,
    makeSale,
  }) => {
    const sale = await makeSale({ name: 'E2E One Per User' });
    await page.goto('/');
    await selectSale(page, 'E2E One Per User');

    await buyAs(page, 'e2e-same-user');
    await expect(page.locator('.msg')).toContainText('You got it!');

    await buyAs(page, 'e2e-same-user');
    await expect(page.locator('.msg')).toContainText(
      'You already secured one — one item per person.',
    );

    await expect.poll(async () => (await groundTruth(sale.id)).purchaseRows).toBe(1);
  });

  test('purchase status check reads Postgres for winners and non-winners', async ({
    page,
    makeSale,
  }) => {
    const sale = await makeSale({ name: 'E2E Status Check', totalQuantity: 100 });
    await purchase(sale.id, 'api-winner');

    await page.goto('/');
    await selectSale(page, 'E2E Status Check');

    await page.locator('#user').fill('api-winner');
    await checkStatus(page);
    await expect(page.locator('.msg')).toContainText('secured — confirmed');

    await page.locator('#user').fill('api-loser');
    await checkStatus(page);
    await expect(page.locator('.msg')).toContainText('no purchase found for this user');
  });
});