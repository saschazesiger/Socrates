import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v.trim();
}

export const config = {
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    allowedUserIds: required('ALLOWED_USER_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  openrouter: {
    apiKey: required('OPENROUTER_API_KEY'),
    model: required('OPENROUTER_MODEL'),
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    region: required('S3_REGION'),
    bucket: required('S3_BUCKET'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    prefix: (process.env.S3_PREFIX?.trim() || '').replace(/^\/+|\/+$/g, ''),
  },
  port: parseInt(process.env.PORT || '3000', 10),
  timezone: process.env.PERSON_TIMEZONE?.trim() || 'Europe/Zurich',
  // How many messages chat.jsonl keeps per conversation.
  chatHistoryLimit: 200,
};
