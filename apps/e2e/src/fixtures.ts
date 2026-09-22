import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test as base } from '@playwright/test';
import type { AdminSaleRecord } from '@flash-sale/shared';
import { adminCreateSale, adminDeleteSale } from './helpers/api';
import { env } from './helpers/env';

/**
 * Base test with a `makeSale` fixture: creates a dedicated sale through the
 * real admin API with a unique id, returns it, and deletes it (with any
 * purchases) when the test ends — so each test starts from a known state and
 * never decorates the shared dev DB twice over.
 */
export interface MakeSaleOptions {
  name?: string;
  priceCents?: number;
  totalQuantity?: number;
  startAt?: string;
  endAt?: string;
}

export const test = base.extend<{ makeSale: (o?: MakeSaleOptions) => Promise<AdminSaleRecord> }>({
  // Playwright requires fixture functions to take a destructured fixtures
  // object; the empty pattern is the idiom for "no other fixtures needed".
  // eslint-disable-next-line no-empty-pattern
  makeSale: async ({}, use) => {
    const created: string[] = [];

    const makeSale = async (o: MakeSaleOptions = {}): Promise<AdminSaleRecord> => {
      const suffix = randomUUID().slice(0, 8);
      const sale = await adminCreateSale({
        id: `e2e-${suffix}`,
        name: o.name ?? `E2E Drop ${suffix}`,
        priceCents: o.priceCents ?? 4200,
        totalQuantity: o.totalQuantity ?? 1000,
        startAt: o.startAt ?? new Date(Date.now() - 2 * 60_000).toISOString(),
        endAt: o.endAt ?? new Date(Date.now() + 20 * 60_000).toISOString(),
      });
      created.push(sale.id);
      return sale;
    };

    await use(makeSale);

    // Best-effort teardown: never mask a failed test with a cleanup throw.
    for (const id of created) {
      try {
        await adminDeleteSale(id);
      } catch {
        // already gone
      }
    }
  },
});

export { expect } from '@playwright/test';
export type { Page } from '@playwright/test';

/** Demo-page helpers: pick a sale by name and submit the purchase form. */
export async function selectSale(page: Page, saleName: string): Promise<void> {
  await page.locator('.sale-chip', { hasText: saleName }).click();
}

export async function buyAs(page: Page, userId: string): Promise<void> {
  const input = page.locator('#user');
  await input.fill(userId);
  await page.getByRole('button', { name: 'Buy Now' }).click();
}

export async function checkStatus(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check my purchase status' }).click();
}

export function isoMinutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function apiUrlFor(path: string): string {
  return `${env().apiUrl}${path}`;
}