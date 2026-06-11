import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function optional(name) {
  return process.env[name]?.trim() || '';
}

function normalizeEndpoint(value) {
  if (!value) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return /^https?:\/\//.test(v) ? v : `https://${v}`;
}

function parseList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  telegram: {
    // MTProto userbot credentials (a real user account, not a bot token).
    // api_id / api_hash from https://my.telegram.org → API development tools.
    apiId: parseInt(required('TELEGRAM_API_ID'), 10),
    apiHash: required('TELEGRAM_API_HASH'),
    // StringSession is no longer required here — it is managed at runtime in
    // settings.json (mint it from the dashboard, or `npm run login`). Any value
    // set in the env is used only to SEED settings.json on first boot.
    session: optional('TELEGRAM_SESSION'),
    // Allowed contacts and "allow all" now live in settings.json (editable in
    // the dashboard). The env value, if present, only seeds the initial list.
    allowedUserIds: parseList(process.env.ALLOWED_USER_IDS),
  },
  openrouter: {
    apiKey: required('OPENROUTER_API_KEY'),
    // Model + media model now live in settings.json (editable in the dashboard).
    // The env values, if present, only seed the initial settings.
    model: optional('OPENROUTER_MODEL'),
    mediaModel: optional('OPENROUTER_MEDIA_MODEL'),
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
