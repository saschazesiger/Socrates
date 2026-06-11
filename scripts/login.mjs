/**
 * One-time interactive login to produce TELEGRAM_SESSION.
 *
 *   npm run login
 *
 * Needs TELEGRAM_API_ID and TELEGRAM_API_HASH in the environment (or .env).
 * Prompts for phone number, the login code Telegram sends, and your 2FA
 * password if set. Prints a StringSession to paste into TELEGRAM_SESSION.
 *
 * Run this on the SAME account the persona should speak as.
 */
import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '', 10);
const apiHash = process.env.TELEGRAM_API_HASH?.trim();

if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH (from https://my.telegram.org) first.');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => ask('Phone number (international, e.g. +85291234567): '),
  password: () => ask('2FA password (leave blank if none): '),
  phoneCode: () => ask('Login code Telegram just sent you: '),
  onError: (err) => console.error(err),
});

const me = await client.getMe();
console.log(`\nLogged in as ${me.firstName ?? ''} (id ${me.id}). Your numeric user id is ${me.id}.`);
console.log('\nAdd this to your environment as TELEGRAM_SESSION:\n');
console.log(client.session.save());
console.log('\nKeep it secret — it is full access to this account.');

await client.disconnect();
await rl.close();
process.exit(0);
