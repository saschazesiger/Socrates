import express from 'express';
import { config } from './config.js';
import { loadSettings, getSettings } from './settings.js';
import { loadPerson } from './llm.js';
import { start as startTelegram, setMessageHandler, connectionStatus } from './telegram.js';
import { handleIncoming, restorePendingTimers, followupGuardTick, statusSnapshot } from './bot.js';
import { dashboardRouter } from './dashboard.js';

const app = express();

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/status', async (_req, res) => {
  try {
    res.json({
      model: getSettings().model,
      mediaModel: getSettings().mediaModel,
      paused: getSettings().behavior.paused,
      timezone: config.timezone,
      uptimeSeconds: Math.round(process.uptime()),
      connection: await connectionStatus(),
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
  await loadSettings(); // runtime config (session, models, allow-list, behavior)
  await loadPerson(); // fail fast if person.md is missing
  // Register the handler before the dashboard can trigger a login/restart, so a
  // very-early browser login still ends up listening for messages.
  setMessageHandler(handleIncoming);
  app.listen(config.port, () => console.log(`[http] listening on :${config.port}`));
  await restorePendingTimers();
  // Followup guard: ensures every contact always has a followup planned.
  // First pass shortly after boot, then hourly.
  setTimeout(() => followupGuardTick().catch(() => {}), 90 * 1000);
  setInterval(() => followupGuardTick().catch(() => {}), config.followupGuardIntervalMs);
  // Non-fatal: if there's no authorised session yet, the server stays up so the
  // account can be logged in from the dashboard (Connection tab).
  await startTelegram(handleIncoming);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
