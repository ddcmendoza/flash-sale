import { describe, expect, it } from 'vitest';
import { resolveSaleStatus } from '@flash-sale/shared';

function sale(overrides: Partial<{ startAt: Date; endAt: Date; soldCount: number; totalQuantity: number }> = {}) {
  const base = {
    startAt: new Date('2026-01-01T10:00:00.000Z'),
    endAt: new Date('2026-01-01T11:00:00.000Z'),
    soldCount: 0,
    totalQuantity: 100,
  };
  return { ...base, ...overrides };
}

describe('resolveSaleStatus', () => {
  it('is upcoming before start_at', () => {
    expect(
      resolveSaleStatus(sale(), new Date('2026-01-01T09:59:59.999Z')),
    ).toBe('upcoming');
  });

  it('is active exactly at start_at (inclusive)', () => {
    expect(
      resolveSaleStatus(sale(), new Date('2026-01-01T10:00:00.000Z')),
    ).toBe('active');
  });

  it('is active mid-window with stock', () => {
    expect(
      resolveSaleStatus(sale(), new Date('2026-01-01T10:30:00.000Z')),
    ).toBe('active');
  });

  it('flips to sold_out the instant the last unit is gone', () => {
    expect(
      resolveSaleStatus(
        sale({ soldCount: 100, totalQuantity: 100 }),
        new Date('2026-01-01T10:30:00.000Z'),
      ),
    ).toBe('sold_out');
  });

  it('is active exactly at end_at (inclusive)', () => {
    expect(
      resolveSaleStatus(sale(), new Date('2026-01-01T11:00:00.000Z')),
    ).toBe('active');
  });

  it('is ended one millisecond after end_at', () => {
    expect(
      resolveSaleStatus(sale(), new Date('2026-01-01T11:00:00.001Z')),
    ).toBe('ended');
  });
});