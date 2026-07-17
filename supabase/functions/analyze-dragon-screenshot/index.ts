// supabase/functions/analyze-dragon-screenshot/index.ts
//
// Secure server-side endpoint for the Dragon Screenshot Import feature.
// Receives one base64 image at a time, calls a vision-capable AI model with a
// strict system prompt, validates the shape of what comes back, and returns
// it. The AI API key never reaches the browser — it only lives here, as a
// Supabase Edge Function secret.
//
// Deploy with the Supabase CLI from the project root:
//   supabase functions deploy analyze-dragon-screenshot
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// See .env.example in this folder for the required/optional secrets.

import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-4-6';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB, matches the client-side limit
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_IMAGES_PER_REQUEST = 10; // safety cap independent of the client's own batch limit

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your site's origin in production
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `You analyze a single screenshot from a mobile game's dragon roster or detail screen.
Identify every dragon shown and extract, for each one:
- name (string, the dragon's displayed name)
- starRank (integer 1-10, the dragon's star rank — NOT its level)
- level (integer, the dragon's current level — distinct from star rank and from max level)
- maxLevel (integer, the dragon's maximum possible level, only if visibly shown)
- confidence (object with name/starRank/level/maxLevel, each a number 0-1)

Rules:
- Never guess a value that is not visibly legible. Use null for anything uncertain or absent.
- Do not confuse level with star rank, troop capacity, power, or any other stat.
- If multiple dragons appear in the image, return one entry per dragon.
- If no dragon is identifiable, return an empty dragons array.

Respond with ONLY strict JSON matching exactly this shape, no prose, no markdown fences:
{"dragons":[{"name":string|null,"dragonId":null,"starRank":number|null,"level":number|null,"maxLevel":number|null,"confidence":{"name":number,"starRank":number,"level":number,"maxLevel":number},"needsReview":boolean,"reviewNotes":string[]}]}`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Analysis request timed out.')), ms)),
  ]);
}

async function callAnthropicVision(base64Image: string, mimeType: string) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
            { type: 'text', text: 'Analyze this dragon screenshot and respond with the JSON shape only.' },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI service returned ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const textBlock = Array.isArray(data.content) ? data.content.find((b: any) => b.type === 'text') : null;
  if (!textBlock || typeof textBlock.text !== 'string') {
    throw new Error('AI response did not include a text block.');
  }
  // Strip any accidental markdown fences before parsing — we never trust this blindly.
  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('AI response was not valid JSON.');
  }
  return parsed;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);

  if (!ANTHROPIC_API_KEY) {
    // Fails closed, with a clear message — never silently pretend to work.
    return jsonResponse({ error: 'Image analysis is not configured on the server (missing ANTHROPIC_API_KEY).' }, 503);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Request body must be JSON.' }, 400);
  }

  const images = Array.isArray(body?.images) ? body.images : null;
  if (!images || images.length === 0) {
    return jsonResponse({ error: 'Request must include a non-empty "images" array.' }, 400);
  }
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return jsonResponse({ error: `Too many images in one request (max ${MAX_IMAGES_PER_REQUEST}).` }, 400);
  }

  const results: any[] = [];
  for (const img of images) {
    const filename = typeof img?.filename === 'string' ? img.filename.slice(0, 200) : 'unknown';
    const mimeType = typeof img?.mimeType === 'string' ? img.mimeType : '';
    const base64Data = typeof img?.base64 === 'string' ? img.base64 : '';

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      results.push({ filename, error: `Unsupported image type "${mimeType}".` });
      continue;
    }
    // Rough size check on the base64 payload (base64 is ~4/3 the byte size).
    if (base64Data.length * 0.75 > MAX_IMAGE_BYTES) {
      results.push({ filename, error: 'Image is too large.' });
      continue;
    }
    if (!base64Data) {
      results.push({ filename, error: 'Image could not be read.' });
      continue;
    }

    try {
      const parsed = await withTimeout(callAnthropicVision(base64Data, mimeType), REQUEST_TIMEOUT_MS);
      results.push({ filename, response: parsed });
    } catch (e) {
      // Deliberately no image bytes or full AI response logged here — only
      // the error message, per the "avoid logging sensitive API responses" requirement.
      console.error('[analyze-dragon-screenshot] failed for', filename, '-', (e as Error).message);
      results.push({ filename, error: (e as Error).message || 'Analysis failed.' });
    }
  }

  return jsonResponse({ results });
});
