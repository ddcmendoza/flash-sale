import { buyAs, expect, isoMinutesFromNow, selectSale, test } from '../fixtures';
import { adminUpdateSale } from '../helpers/api';
import { groundTruth } from '../helpers/db';

test.describe('sale window enforcement', () => {
  test('upcoming: purchase is refused and the badge says starts soon', async ({
    page,
    makeSale,
  }) => {
    const sale = await makeSale({
      name: 'E2E Upcoming Drop',
      startAt: isoMinutesFromNow(15),
      endAt: isoMinutesFromNow(75),
    });
    await page.goto('/');
    await selectSale(page, 'E2E Upcoming Drop');

    await expect(page.locator('.badge')).toHaveText('starts soon');
    await buyAs(page, 'e2e-early');
    await expect(page.locator('.msg')).toContainText('The sale has not started yet.');

    await expect.poll(async () => (await groundTruth(sale.id)).purchaseRows).toBe(0);
  });

  test('ended: closing the window flips the badge over SSE and refuses buys', async ({
    page,
    makeSale,
  }) => {
    const sale = await makeSale({
      name: 'E2E Ended Drop',
      startAt: isoMinutesFromNow(15),
      endAt: isoMinutesFromNow(75),
    });
    await page.goto('/');
    await selectSale(page, 'E2E Ended Drop');

    // Close the window through the admin API; the broadcaster converges the UI.
    await adminUpdateSale(sale.id, {
      startAt: isoMinutesFromNow(-120),
      endAt: isoMinutesFromNow(-90),
    });
    await expect(page.locator('.badge')).toHaveText('ended');

    await buyAs(page, 'e2e-late');
    await expect(page.locator('.msg')).toContainText('This sale has ended.');
  });

  test('sold out: last unit is claimed, next buyer refused, badge flips', async ({
    page,
    makeSale,
  }) => {
    const sale = await makeSale({ name: 'E2E Sold Out', totalQuantity: 1 });
    await page.goto('/');
    await selectSale(page, 'E2E Sold Out');

    await buyAs(page, 'e2e-winner');
    await expect(page.locator('.msg')).toContainText('You got it!');

    await buyAs(page, 'e2e-loser');
    await expect(page.locator('.msg')).toContainText('Sold out. Better luck next drop!');
    await expect(page.locator('.badge')).toHaveText('sold out');

    await expect.poll(async () => (await groundTruth(sale.id)).purchaseRows).toBe(1);
  });
});