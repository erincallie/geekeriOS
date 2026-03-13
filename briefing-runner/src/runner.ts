#!/usr/bin/env tsx
// ─── GeekeriOS Briefing Runner v3.1 ─────────────────────────
// Gathers data from HubSpot, Google Calendar, Gmail, Slack,
// Fireflies, Google Drive. Tracks action items across runs.
// Saves metric snapshots for Friday retros.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { getPrompt, SYSTEM_PROMPT, type BriefingType } from './prompts.js';
import { gatherHubSpot } from './sources/hubspot.js';
import { gatherCalendar } from './sources/gcal.js';
import { gatherGmail } from './sources/gmail.js';
import { gatherSlack } from './sources/slack.js';
import { gatherFireflies } from './sources/fireflies.js';
import { gatherDrive } from './sources/gdrive.js';
import { getOpenItems, saveActionItems, pruneItems } from './sources/action-tracker.js';
import { saveDailySnapshot, getWeeklyComparison, parseHubSpotMetrics } from './sources/snapshots.js';

// ─── Config ──────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const CLAUDE_PROJECT_ID = process.env.CLAUDE_PROJECT_ID;

if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY is required in .env');
  process.exit(1);
}

// ─── Project Link Footer ────────────────────────────────────
// Appends a link to the GeekeriOS project in Claude Desktop/Web.
// On macOS with Claude Desktop installed, the web link opens the app.

function getProjectFooter(): string {
  if (!CLAUDE_PROJECT_ID) return '';
  return `\n———\n:geekerios: <https://claude.ai/project/${CLAUDE_PROJECT_ID}|Open in GeekeriOS>`;
}

// ─── Day + Time Detection ────────────────────────────────────

const timeSlot = process.argv[2] as 'morning' | 'evening';
const isDryRun = process.argv.includes('--dry-run');

if (!timeSlot || !['morning', 'evening'].includes(timeSlot)) {
  console.error('Usage: npx tsx src/runner.ts <morning|evening> [--dry-run]');
  process.exit(1);
}

const now = new Date();
const dayOfWeek = now.getDay();

if (dayOfWeek === 0 || dayOfWeek === 6) {
  console.log(`📅 Weekend — skipping briefing.`);
  process.exit(0);
}

let briefingType: BriefingType;
if (timeSlot === 'morning' && dayOfWeek === 1) briefingType = 'morning-monday';
else if (timeSlot === 'evening' && dayOfWeek === 5) briefingType = 'evening-friday';
else briefingType = timeSlot;

const dateStr = now.toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  timeZone: 'America/Denver',
});

console.log(`🚀 Running ${briefingType} briefing for ${dateStr}`);
if (isDryRun) console.log('🧪 DRY RUN — will not post to Slack\n');

// ─── Slack Alert Helper ──────────────────────────────────────

let googleAlertSent = false;

async function sendSlackAlert(message: string) {
  if (isDryRun) {
    console.log(`  📨 [DRY RUN] Would send Slack alert`);
    return;
  }
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, username: 'GeekeriOS', icon_emoji: ':geekerios:' }),
    });
  } catch { console.error('  ⚠️  Failed to send Slack alert'); }
}

// ─── Gather Data from All Sources ────────────────────────────

interface SourceResult {
  name: string;
  data: string;
  hasRealData: boolean;
  error?: string;
}

async function gatherSource(name: string, fn: () => Promise<string>): Promise<SourceResult> {
  try {
    const data = await fn();
    if (!data) {
      console.log(`  ⚠️  ${name}: not configured`);
      return { name, data: `[${name}: not configured]`, hasRealData: false };
    }
    const hasErrors = data.includes('[') && data.includes('error:');
    const hasRealContent = data.split('\n').some(l => l.startsWith('- ') || l.startsWith('###') || l.startsWith('####'));
    if (hasErrors && !hasRealContent) {
      console.log(`  ❌ ${name}: auth/API error`);
      console.log(`     ${data.split('\n').filter(l => l.includes('error')).join('\n     ')}`);
      return { name, data, hasRealData: false, error: data };
    }
    console.log(`  ✅ ${name}: data gathered`);
    return { name, data, hasRealData: true };
  } catch (err: any) {
    console.log(`  ❌ ${name}: ${err.message}`);
    return { name, data: `[${name} error: ${err.message}]`, hasRealData: false, error: err.message };
  }
}

async function gatherAllData(): Promise<string> {
  const coreResults = await Promise.all([
    gatherSource('HubSpot', () => gatherHubSpot(briefingType)),
    gatherSource('Calendar', () => gatherCalendar(briefingType)),
    gatherSource('Gmail', () => gatherGmail()),
    gatherSource('Slack', () => gatherSlack()),
  ]);

  const conditionalResults: SourceResult[] = [];

  if (briefingType === 'evening' || briefingType === 'evening-friday') {
    conditionalResults.push(
      await gatherSource('Fireflies', () => gatherFireflies())
    );
  }

  if (briefingType === 'morning-monday') {
    conditionalResults.push(
      await gatherSource('Google Drive', () => gatherDrive(7))
    );
  }

  const allResults = [...coreResults, ...conditionalResults];
  const successCount = allResults.filter(r => r.hasRealData).length;
  const totalCount = allResults.length;
  console.log(`\n📊 Data sources: ${successCount}/${totalCount} connected\n`);

  const googleFailures = allResults.filter(r =>
    !r.hasRealData && r.error &&
    (r.error.includes('invalid_grant') || r.error.includes('Token has been expired') || r.error.includes('unauthorized_client'))
  );
  if (googleFailures.length > 0 && !googleAlertSent) {
    googleAlertSent = true;
    await sendSlackAlert(
      `🚨 *GeekeriOS: Google token needs re-authorization*\n\n` +
      `Briefing couldn't pull Calendar/Gmail/Drive data. Re-authorize at the OAuth Playground with your Client ID/Secret.\n` +
      `Details in \`~/Desktop/geekeriOS/briefing-runner/SETUP.md\``
    );
  }

  const sections = allResults.map(r => `## ${r.name} Data\n${r.data}`);

  if (briefingType === 'morning' || briefingType === 'morning-monday') {
    const openItems = getOpenItems();
    if (openItems) sections.push(`## Open Action Items\n${openItems}`);
  }

  if (briefingType === 'evening-friday') {
    const comparison = getWeeklyComparison();
    sections.push(`## Weekly Metrics Comparison\n${comparison}`);
  }

  const hubspotResult = coreResults.find(r => r.name === 'HubSpot');
  if (hubspotResult?.hasRealData) {
    const metrics = parseHubSpotMetrics(hubspotResult.data);
    if (metrics) saveDailySnapshot(metrics);
  }

  pruneItems();

  return sections.join('\n\n');
}

// ─── Run the Briefing ────────────────────────────────────────

async function runBriefing() {
  console.log('📡 Gathering data from services...');
  const contextData = await gatherAllData();

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const templatePrompt = getPrompt(briefingType, dateStr, SLACK_CHANNEL_ID);

  const userPrompt = `
Here is the live data gathered from my systems:

${contextData}

---

Based on the data above, ${templatePrompt.replace(
    /Deliver .+ to Slack channel \S+\.?\s*/,
    'compose the briefing. '
  ).replace(
    /Gather data and then post a briefing covering/g,
    'Cover the following'
  ).replace(
    /Gather data and then post covering/g,
    'Cover the following'
  ).replace(
    /Gather data and then post a wrap-up covering/g,
    'Cover the following'
  )}

IMPORTANT: Use ONLY the real data provided above. Where data is missing (marked with [error] or [not configured]),
briefly note that source was unavailable — do NOT invent placeholder data.
Output ONLY the briefing text formatted for Slack mrkdwn. No preamble.

${briefingType.includes('evening') ? `
ALSO: At the very end of your response, after the briefing text, output a section wrapped in
<action_items> tags listing the specific action items you identified. Each on its own line.
Format: SOURCE | ITEM TEXT | DUE DATE (or "none")
Example:
<action_items>
email | Reply to Chris about the Value-First Delivery meeting | 2026-03-13
hubspot | Follow up on Netfluence automation deal | none
fireflies | Send meeting notes to attendees from RevOps session | 2026-03-13
</action_items>
This section will be parsed programmatically — keep it clean.` : ''}`;

  console.log('🤖 Calling Anthropic API...');
  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Response received in ${elapsed}s`);

    let fullText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    // ─── Parse and save action items from evening wraps ──────
    if (briefingType.includes('evening')) {
      const aiMatch = fullText.match(/<action_items>([\s\S]*?)<\/action_items>/);
      if (aiMatch) {
        const items = aiMatch[1]
          .trim()
          .split('\n')
          .filter(line => line.includes('|'))
          .map(line => {
            const [source, text, due] = line.split('|').map(s => s.trim());
            return {
              text: text || line,
              source: source || 'briefing',
              dueDate: due && due !== 'none' ? due : undefined,
            };
          });

        if (items.length > 0) {
          saveActionItems(items);
        }

        fullText = fullText.replace(/<action_items>[\s\S]*?<\/action_items>/, '').trim();
      }
    }

    if (isDryRun) {
      console.log('\n─── BRIEFING PREVIEW ───────────────────\n');
      console.log(fullText);
      console.log(getProjectFooter());
      console.log('\n─── END PREVIEW ────────────────────────\n');
    } else {
      await postViaWebhook(fullText);
    }

    console.log(`📊 Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  } catch (err: any) {
    console.error('❌ Briefing failed:', err?.message || err);
    process.exit(1);
  }
}

// ─── Slack Webhook Posting ───────────────────────────────────

async function postViaWebhook(text: string) {
  // Append the project link footer
  const fullMessage = text + getProjectFooter();

  const resp = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: fullMessage, username: 'GeekeriOS', icon_emoji: ':geekerios:' }),
  });
  if (!resp.ok) {
    console.error(`❌ Webhook failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  console.log('✅ Posted to Slack via webhook');
}

// ─── Go ──────────────────────────────────────────────────────
runBriefing();
