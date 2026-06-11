import express from 'express';
import { config } from './config.js';
import { loadPerson } from './llm.js';
import { startPolling } from './telegram.js';
import { handleIncoming, restorePendingTimers, followupGuardTick, statusSnapshot } from './bot.js';
import { dashboardRouter } from './dashboard.js';

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

if (config.dashboard.password) {
  app.use('/', dashboardRouter());
} else {
  console.warn('[dashboard] DASHBOARD_PASSWORD not set — dashboard disabled');
}

async function main() {
  await loadPerson(); // fail fast if person.md is missing
  app.listen(config.port, () => console.log(`[http] listening on :${config.port}`));
  await restorePendingTimers();
  // Followup guard: ensures every contact always has a followup planned.
  // First pass shortly after boot, then hourly.
  setTimeout(() => followupGuardTick().catch(() => {}), 90 * 1000);
  setInterval(() => followupGuardTick().catch(() => {}), config.followupGuardIntervalMs);
  await startPolling(handleIncoming);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
