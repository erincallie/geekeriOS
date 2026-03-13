// ─── Google OAuth Token Refresh ─────────────────────────────
// Handles refreshing Google access tokens using the refresh token.

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

export function isGoogleConfigured(): boolean {
  if (!GOOGLE_CLIENT_ID) return false;
  if (!GOOGLE_CLIENT_SECRET) return false;
  if (!GOOGLE_REFRESH_TOKEN) return false;
  return true;
}

export function getGoogleConfigStatus(): string {
  const parts = [];
  if (!GOOGLE_CLIENT_ID) parts.push('GOOGLE_CLIENT_ID missing');
  if (!GOOGLE_CLIENT_SECRET) parts.push('GOOGLE_CLIENT_SECRET missing');
  if (!GOOGLE_REFRESH_TOKEN) parts.push('GOOGLE_REFRESH_TOKEN missing');
  if (parts.length === 0) return 'all configured';
  return parts.join(', ');
}

export async function getGoogleAccessToken(): Promise<string> {
  if (!isGoogleConfigured()) {
    throw new Error(`Google OAuth not configured: ${getGoogleConfigStatus()}`);
  }

  // Return cached token if still valid (with 60s buffer)
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  console.log('    🔄 Refreshing Google access token...');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      refresh_token: GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });

  const body = await resp.text();

  if (!resp.ok) {
    // Parse the error for a helpful message
    let detail = `HTTP ${resp.status}`;
    try {
      const err = JSON.parse(body);
      detail = `${err.error}: ${err.error_description || 'no details'}`;
    } catch {}
    throw new Error(`Google token refresh failed: ${detail}`);
  }

  const data = JSON.parse(body) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log(`    ✅ Google token refreshed (expires in ${data.expires_in}s)`);
  return cachedAccessToken;
}
