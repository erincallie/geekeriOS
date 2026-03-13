// ─── Google Calendar Data Gatherer ──────────────────────────
// Uses Google Calendar REST API v3 with OAuth refresh token.

import type { BriefingType } from '../prompts.js';
import { isGoogleConfigured, getGoogleAccessToken } from './google-auth.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

async function gcalGet(path: string): Promise<any> {
  const token = await getGoogleAccessToken();
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`GCal ${path}: ${resp.status}`);
  return resp.json();
}

export async function gatherCalendar(briefingType: BriefingType): Promise<string> {
  if (!isGoogleConfigured()) return '';

  const sections: string[] = [];
  const now = new Date();

  // Determine time range based on briefing type
  let timeMin: Date;
  let timeMax: Date;

  if (briefingType === 'morning-monday') {
    // Full week Mon–Fri
    timeMin = new Date(now);
    timeMin.setHours(0, 0, 0, 0);
    timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + 5);
  } else if (briefingType === 'evening' || briefingType === 'evening-friday') {
    // Today + tomorrow
    timeMin = new Date(now);
    timeMin.setHours(0, 0, 0, 0);
    timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + 2);
  } else {
    // Today only
    timeMin = new Date(now);
    timeMin.setHours(0, 0, 0, 0);
    timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + 1);
  }

  try {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });

    const events = await gcalGet(`/calendars/primary/events?${params}`);

    if (events.items?.length) {
      sections.push(`### Calendar events (${timeMin.toLocaleDateString()} – ${timeMax.toLocaleDateString()}):`);
      for (const e of events.items) {
        const start = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })
          : 'All day';
        const end = e.end?.dateTime
          ? new Date(e.end.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' })
          : '';
        const day = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Denver' })
          : new Date(e.start?.date).toLocaleDateString('en-US', { weekday: 'short' });

        const attendees = e.attendees?.length
          ? ` | ${e.attendees.length} attendees`
          : '';
        const location = e.location ? ` | ${e.location}` : '';

        sections.push(`- [${day}] ${start}${end ? '–' + end : ''} — ${e.summary || '(no title)'}${attendees}${location}`);
      }
    } else {
      sections.push('### Calendar: No events found in this time range.');
    }
  } catch (e: any) {
    sections.push(`[Calendar error: ${e.message}]`);
  }

  return sections.join('\n') || '';
}
