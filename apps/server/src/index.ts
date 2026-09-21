import { buildApp } from './app';
import { config } from './config';

async function main(): Promise<void> {
  const { app } = buildApp({ logger: true, purchaseMode: config.purchaseMode });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `flash sale server up (mode=${config.purchaseMode}, sale=${config.saleId})`,
  );
}

void main().catch((err) => {
  console.error('fatal: failed to start server', err);
  process.exit(1);
});