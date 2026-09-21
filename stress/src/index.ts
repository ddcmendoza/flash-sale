import { Pool } from 'pg';
import { config } from './stressConfig';
import { runLoad, type AttemptResult } from './loadgen';
import { readGroundTruth, resetSale, listWinners } from './groundTruth';

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

function histogram(rows: AttemptResult[]): Map<string, { count: number; status: number }> {
  const map = new Map<string, { count: number; status: number }>();
  for (const r of rows) {
    const key = r.httpStatus === 0 ? 'error' : r.result;
    const entry = map.get(key) ?? { count: 0, status: r.httpStatus };
    entry.count += 1;
    map.set(key, entry);
  }
  return map;
}

async function waitForStock(
  pool: Pool,
  expected: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gt = await readGroundTruth(pool, config.saleId);
    if (gt.distinctPurchases >= expected) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  const userIds = Array.from({ length: config.attempts }, (_, i) => `stress-${i}`);
  const expectedWinners = Math.min(config.attempts, config.stock);

  console.log('Flash sale stress run');
  console.log('='.repeat(60));
  console.log(`target        : ${config.baseUrl}`);
  console.log(`sale          : ${config.saleId}`);
  console.log(`attempts      : ${config.attempts}`);
  console.log(`concurrency   : ${config.concurrency}`);
  console.log(`stock         : ${config.stock} (seeded; sale reset before run)`);

  if (config.reset) {
    await resetSale(pool, config.saleId);
    console.log('\n[sale reset] sold_count = 0, purchases cleared');
  }

  // Cheap liveness probe before committing to a full run.
  const warm = await fetch(`${config.baseUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
  if (!warm.ok) {
    console.error(`FATAL: server not healthy (HTTP ${warm.status}). Start the API first.`);
    process.exit(1);
  }

  const wallStart = performance.now();
  const results = await runLoad({
    baseUrl: config.baseUrl,
    userIds,
    concurrency: config.concurrency,
  });
  const wallMs = performance.now() - wallStart;

  // In queue mode the worker commits asynchronously; give it a moment.
  if (results.some((r) => r.result === 'accepted')) {
    console.log('\n[queue mode] waiting for workers to flush…');
    const done = await waitForStock(pool, expectedWinners, 60_000);
    if (!done) {
      console.error(`FATAL: queue workers did not commit ${expectedWinners} purchases in time`);
      process.exit(1);
    }
  }

  const histogramByResult = histogram(results);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const gt = await readGroundTruth(pool, config.saleId);
  const winners = await listWinners(pool, config.saleId);

  console.log('\nresults');
  console.log('-'.repeat(60));
  for (const [key, entry] of histogramByResult) {
    console.log(`  ${key.padEnd(22)} ${String(entry.count).padStart(6)}`);
  }
  if (results.some((r) => r.httpStatus === 0)) {
    const errs = results.filter((r) => r.httpStatus === 0);
    console.log(`  (${errs.length} transport-level errors, first: ${errs[0]?.error})`);
  }

  console.log('\nthroughput & latency');
  console.log('-'.repeat(60));
  console.log(`  duration     : ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`  throughput   : ${Math.round((results.length / wallMs) * 1000)} req/s`);
  console.log(`  latency p50  : ${percentile(latencies, 0.5).toFixed(1)} ms`);
  console.log(`  latency p95  : ${percentile(latencies, 0.95).toFixed(1)} ms`);
  console.log(`  latency p99  : ${percentile(latencies, 0.99).toFixed(1)} ms`);

  console.log('\nverification (Postgres ground truth)');
  console.log('-'.repeat(60));
  console.log(`  sold_count           : ${gt.soldCount}`);
  console.log(`  distinct purchases   : ${gt.distinctPurchases}`);
  console.log(`  total_quantity       : ${gt.totalQuantity}`);
  console.log(`  unique winners       : ${new Set(winners).size}`);

  const failures = verify(results, gt, expectedWinners);

  if (failures.length === 0) {
    console.log('\nRESULT: PASS — invariants held under load\n');
  } else {
    console.log('\nRESULT: FAIL');
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
  await pool.end();
}

function verify(
  results: AttemptResult[],
  gt: { soldCount: number; distinctPurchases: number; totalQuantity: number },
  expectedWinners: number,
): string[] {
  const failures: string[] = [];
  const queueMode = results.some((r) => r.result === 'accepted');

  const purchased = results.filter((r) => r.result === 'purchased');
  const boughtUserIds = new Set(purchased.map((r) => r.userId));

  if (!queueMode) {
    if (purchased.length !== expectedWinners) {
      failures.push(
        `expected ${expectedWinners} "purchased" responses, got ${purchased.length}`,
      );
    }
    if (boughtUserIds.size !== purchased.length) {
      failures.push('a user appears to have "purchased" more than once in responses');
    }
    if (purchased.some((r) => r.httpStatus !== 201)) {
      failures.push('a "purchased" response did not carry HTTP 201');
    }
  } else {
    const accepted = results.filter((r) => r.result === 'accepted');
    if (accepted.some((r) => r.httpStatus !== 202)) {
      failures.push('an "accepted" response did not carry HTTP 202');
    }
  }

  if (gt.soldCount !== expectedWinners) {
    failures.push(
      `sold_count=${gt.soldCount} but only ${expectedWinners} were expected`,
    );
  }
  if (gt.soldCount !== gt.distinctPurchases) {
    failures.push(
      `sold_count (${gt.soldCount}) disagrees with purchase rows (${gt.distinctPurchases})`,
    );
  }
  if (gt.soldCount > gt.totalQuantity) {
    failures.push(`OVERSOLD: ${gt.soldCount} > ${gt.totalQuantity}`);
  }
  const unexpected = results.filter(
    (r) => !['purchased', 'already_purchased', 'sold_out', 'ended', 'accepted', 'upcoming', 'error'].includes(r.result),
  );
  if (unexpected.length > 0) {
    failures.push(`unexpected result kinds: ${[...new Set(unexpected.map((r) => r.result))].join(', ')}`);
  }
  return failures;
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});