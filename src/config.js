import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function normalizeEndpoint(value) {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return /^https?:\/\//.test(v) ? v : `https://${v}`;
}

export const config = {
  telegram: {
    // MTProto userbot credentials (a real user account, not a bot token).
    // api_id / api_hash from https://my.telegram.org → API development tools.
    apiId: parseInt(required('TELEGRAM_API_ID'), 10),
    apiHash: required('TELEGRAM_API_HASH'),
    // StringSession produced once by `npm run login`. Optional only so the
    // login script itself can run without it.
    session: process.env.TELEGRAM_SESSION?.trim() || '',
    allowedUserIds: required('ALLOWED_USER_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  openrouter: {
    apiKey: required('OPENROUTER_API_KEY'),
    model: required('OPENROUTER_MODEL'),
    // Vision/audio-capable model for photo descriptions & voice transcription.
    // Falls back to the main model if unset.
    mediaModel: process.env.OPENROUTER_MEDIA_MODEL?.trim() || required('OPENROUTER_MODEL'),
  },
  s3: {
    endpoint: normalizeEndpoint(process.env.S3_ENDPOINT),
    region: required('S3_REGION'),
    bucket: required('S3_BUCKET'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    prefix: (process.env.S3_PREFIX?.trim() || '').replace(/^\/+|\/+$/g, ''),
  },
  dashboard: {
    // If unset, the dashboard is disabled entirely.
    password: process.env.DASHBOARD_PASSWORD?.trim() || null,
  },
  port: parseInt(process.env.PORT || '3000', 10),
  timezone: process.env.PERSON_TIMEZONE?.trim() || 'Europe/Zurich',
  // How many messages chat.jsonl keeps per conversation.
  chatHistoryLimit: 200,
  // How often the followup guard runs (ensures every contact always has a
  // pending followup scheduled).
  followupGuardIntervalMs: 60 * 60 * 1000,
};
