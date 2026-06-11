import express from 'express';
import { config } from './config.js';
import { loadPerson } from './llm.js';
import { startPolling } from './telegram.js';
import { handleIncoming, restorePendingTimers, statusSnapshot } from './bot.js';

const app = express();

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/status', async (_req, res) => {
  try {
    res.json({
      model: config.openrouter.model,
      timezone: config.timezone,
      uptimeSeconds: Math.round(process.uptime()),
      users: await statusSnapshot(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function main() {
  await loadPerson(); // fail fast if person.md is missing
  app.listen(config.port, () => console.log(`[http] listening on :${config.port}`));
  await restorePendingTimers();
  await startPolling(handleIncoming);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
