/**
 * Incoming media → text. Photos are described and voice notes transcribed via
 * the OPENROUTER_MEDIA_MODEL (must be vision/audio capable — Gemini Flash
 * works well). The textual representation is what lands in chat.jsonl, so the
 * rest of the pipeline stays text-only.
 *
 * If transcription/description fails, a graceful placeholder is stored — the
 * persona can then react like a human who couldn't listen right now.
 */
import { downloadMedia } from './telegram.js';
import { chatCompletion } from './llm.js';
import { getSettings } from './settings.js';

/** The model used for vision/audio — falls back to the main model. */
function mediaModel() {
  const s = getSettings();
  return s.mediaModel || s.model || undefined;
}

/**
 * Returns the text representation of an incoming Telegram message,
 * resolving photos and voice notes. Plain text passes through unchanged.
 * `msg` is the normalized message from telegram.js (carries `raw` for download).
 */
export async function messageToText(msg) {
  if (msg.isPhoto) {
    const caption = msg.caption ? ` (caption: "${msg.caption}")` : '';
    try {
      const buf = await downloadMedia(msg.raw);
      const description = await describePhoto(buf);
      return `[sent a photo${caption}: ${description}]`;
    } catch (err) {
      console.error('[media] photo description failed:', err.message);
      return `[sent a photo${caption} — could not be loaded]`;
    }
  }

  if (msg.voice) {
    const dur = msg.voice.duration ?? 0;
    try {
      const buf = await downloadMedia(msg.raw);
      const transcript = await transcribeVoice(buf, 'audio/ogg');
      return `[sent a voice message, ${dur}s: "${transcript}"]`;
    } catch (err) {
      console.error('[media] voice transcription failed:', err.message);
      return `[sent a voice message, ${dur}s — could not be listened to right now]`;
    }
  }

  return msg.text || '[unsupported message type]';
}

async function describePhoto(buffer) {
  const text = await chatCompletion(
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this photo in 1-2 sentences from the perspective of someone receiving it in a chat. Include any visible text. Plain text only.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` },
          },
        ],
      },
    ],
    { model: mediaModel(), temperature: 0.2 }
  );
  return text.trim();
}

async function transcribeVoice(buffer, mimeType = 'audio/ogg') {
  const format = mimeType.includes('mp3') ? 'mp3' : mimeType.includes('wav') ? 'wav' : 'ogg';
  const text = await chatCompletion(
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcribe this voice message verbatim, in its original language. Output only the transcript.',
          },
          {
            type: 'input_audio',
            input_audio: { data: buffer.toString('base64'), format },
          },
        ],
      },
    ],
    { model: mediaModel(), temperature: 0 }
  );
  return text.trim();
}
