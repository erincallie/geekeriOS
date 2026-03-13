#!/usr/bin/env tsx
// ─── Google Token Keepalive ─────────────────────────────────
// Runs daily (including weekends) via launchd to keep the Google
// OAuth refresh token alive. Google "Testing" mode tokens expire
// after 7 days of INACTIVITY — this script ensures at least one
// refresh happens every day.
//
// If the refresh fails (token already expired), it posts an alert
// to Slack so you know to re-auth via the OAuth Playground.
//
// Usage:
//   npx tsx src/keepalive.ts          # normal run
//   npx tsx src/keepalive.ts --quiet  # suppress success output

import 'dotenv/config';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const CLAUDE_PROJECT_ID = process.env.CLAUDE_PROJECT_ID;

const quiet = process.argv.includes('--quiet');

function log(msg: string) {
  if (!quiet) console.log(msg);
}

function getProjectFooter(): string {
  if (!CLAUDE_PROJECT_ID) return '';
  return `\n———\n:geekerios: <https://claude.ai/project/${CLAUDE_PROJECT_ID}|Open in GeekeriOS>`;
}

async function alertSlack(message: string) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: message + getProjectFooter(),
        username: 'GeekeriOS',
        icon_emoji: ':geekerios:',
      }),
    });
  } catch {
    console.error('Failed to send Slack alert');
  }
}

async function refreshToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    log('⚠️  Google OAuth not configured — nothing to keep alive');
    return;
  }

  log('🔄 Refreshing Google token...');

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const body = await resp.text();

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const err = JSON.parse(body);
      detail = `${err.error}: ${err.error_description || 'no details'}`;
    } catch {}

    const errorMsg = `Google token refresh failed: ${detail}`;
    console.error(`❌ ${errorMsg}`);

    const isFatal = detail.includes('invalid_grant') || detail.includes('Token has been expired or revoked');

    if (isFatal) {
      await alertSlack(
        `🚨 *GeekeriOS Alert: Google token expired*\n\n` +
        `Your Google OAuth refresh token has been revoked or expired. ` +
        `Morning briefings and daily wraps will not include Calendar or Gmail data until you re-authorize.\n\n` +
        `*To fix (2 minutes):*\n` +
        `1. Go to https://developers.google.com/oauthplayground\n` +
        `2. Click ⚙️ → check "Use your own OAuth credentials" → paste your Client ID and Secret\n` +
        `3. Select \`calendar.readonly\` and \`gmail.readonly\` scopes\n` +
        `4. Authorize → Exchange → copy the new \`refresh_token\`\n` +
        `5. Update \`GOOGLE_REFRESH_TOKEN\` in \`~/Desktop/geekeriOS/briefing-runner/.env\``
      );
      console.error('📨 Sent re-auth alert to Slack');
    } else {
      console.error('   (Transient error — will retry next run)');
    }

    process.exit(1);
  }

  const data = JSON.parse(body) as { access_token: string; expires_in: number };
  log(`✅ Google token alive (new access token expires in ${data.expires_in}s)`);
}

refreshToken();
