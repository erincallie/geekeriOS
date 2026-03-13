#!/usr/bin/env tsx
// ─── GeekeriOS Meeting Prep ─────────────────────────────────
// Runs every 30 minutes via launchd. Checks Google Calendar for
// meetings starting in the next 30-45 minutes, cross-references
// attendees with HubSpot contacts/deals, and posts a prep briefing
// to Slack.
//
// Only posts if there's an upcoming meeting with external attendees
// (skips internal-only meetings and focus blocks).

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { isGoogleConfigured, getGoogleAccessToken } from './sources/google-auth.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const YOUR_EMAIL = process.env.YOUR_EMAIL;
const CLAUDE_PROJECT_ID = process.env.CLAUDE_PROJECT_ID;

if (!ANTHROPIC_API_KEY) process.exit(0);
if (!isGoogleConfigured()) {
  console.log('⚠️  Google not configured — skipping meeting prep');
  process.exit(0);
}

function getProjectFooter(): string {
  if (!CLAUDE_PROJECT_ID) return '';
  return `\n———\n:geekerios: <https://claude.ai/project/${CLAUDE_PROJECT_ID}|Open in GeekeriOS>`;
}

// ─── Check for Upcoming Meetings ─────────────────────────────

async function getUpcomingMeetings(): Promise<any[]> {
  const token = await getGoogleAccessToken();
  const now = new Date();
  const soon = new Date(now.getTime() + 45 * 60 * 1000);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: soon.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '5',
  });

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) throw new Error(`Calendar: ${resp.status}`);
  const data = await resp.json();
  return data.items || [];
}

// ─── Look Up Attendees in HubSpot ────────────────────────────

async function lookupContact(email: string): Promise<any | null> {
  if (!HUBSPOT_TOKEN) return null;

  try {
    const resp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/search`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: 'EQ',
              value: email,
            }],
          }],
          properties: ['firstname', 'lastname', 'company', 'jobtitle', 'hs_lead_status', 'notes_last_updated'],
          limit: 1,
        }),
      }
    );

    if (!resp.ok) return null;
    const data = await resp.json();
    return data.results?.[0]?.properties || null;
  } catch {
    return null;
  }
}

async function lookupDeals(email: string): Promise<any[]> {
  if (!HUBSPOT_TOKEN) return [];

  try {
    const contactResp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/search`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
          }],
          properties: ['email'],
          limit: 1,
        }),
      }
    );

    if (!contactResp.ok) return [];
    const contactData = await contactResp.json();
    const contactId = contactData.results?.[0]?.id;
    if (!contactId) return [];

    const dealsResp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/deals`,
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    if (!dealsResp.ok) return [];
    const dealsData = await dealsResp.json();
    const dealIds = dealsData.results?.map((r: any) => r.id) || [];

    const deals: any[] = [];
    for (const dealId of dealIds.slice(0, 3)) {
      const dealResp = await fetch(
        `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealname,amount,dealstage`,
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      if (dealResp.ok) {
        const deal = await dealResp.json();
        deals.push(deal.properties);
      }
    }

    return deals;
  } catch {
    return [];
  }
}

// ─── Main ────────────────────────────────────────────────────

async function run() {
  console.log('🔍 Checking for upcoming meetings...');

  const meetings = await getUpcomingMeetings();
  if (meetings.length === 0) {
    console.log('📅 No meetings in the next 45 minutes');
    return;
  }

  for (const meeting of meetings) {
    if (!meeting.start?.dateTime || !meeting.attendees?.length) continue;

    const externalAttendees = meeting.attendees.filter((a: any) =>
      a.email && a.email !== YOUR_EMAIL && !a.self
    );

    if (externalAttendees.length === 0) continue;

    console.log(`📋 Preparing brief for: ${meeting.summary}`);

    const attendeeIntel: string[] = [];
    for (const attendee of externalAttendees.slice(0, 5)) {
      const contact = await lookupContact(attendee.email);
      const deals = await lookupDeals(attendee.email);

      let intel = `- ${attendee.displayName || attendee.email}`;
      if (contact) {
        intel += ` | ${contact.jobtitle || 'unknown role'} at ${contact.company || 'unknown company'}`;
        if (contact.hs_lead_status) intel += ` | Lead status: ${contact.hs_lead_status}`;
      }
      if (deals.length) {
        for (const d of deals) {
          const amount = d.amount ? `$${Number(d.amount).toLocaleString()}` : '';
          intel += `\n  Deal: ${d.dealname} | ${d.dealstage} ${amount}`;
        }
      }
      attendeeIntel.push(intel);
    }

    const startTime = new Date(meeting.start.dateTime).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver',
    });

    const context = `
Meeting: ${meeting.summary}
Time: ${startTime}
Description: ${meeting.description || 'none'}
Location: ${meeting.location || meeting.hangoutLink || 'no link'}

Attendee intel:
${attendeeIntel.join('\n')}
`.trim();

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: `You are a chief of staff preparing a quick meeting brief. Be concise and actionable — this should take 30 seconds to read. Use Slack mrkdwn formatting. No preamble.`,
      messages: [{
        role: 'user',
        content: `Write a 30-second pre-meeting prep for this meeting. Include: who's attending and what you know about them, any relevant deals in the CRM, and 2-3 suggested talking points or questions based on the context.\n\n${context}`,
      }],
    });

    const prepText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    // Post to Slack with project link footer
    if (SLACK_WEBHOOK_URL) {
      const fullMessage = `📋 *Meeting Prep: ${meeting.summary}* (${startTime})\n\n${prepText}${getProjectFooter()}`;

      await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: fullMessage,
          username: 'GeekeriOS',
          icon_emoji: ':geekerios:',
        }),
      });
      console.log(`✅ Prep posted for: ${meeting.summary}`);
    }
  }
}

run().catch(e => {
  console.error('❌ Meeting prep failed:', e.message);
  process.exit(1);
});
