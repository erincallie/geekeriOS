// ─── Fireflies Meeting Transcript Gatherer ──────────────────
// Uses Fireflies GraphQL API to pull today's meeting transcripts.
// Extracts decisions and action items only (not full summaries).
//
// Get your API key: Fireflies → Integrations → Fireflies API

const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY;
const GRAPHQL_URL = 'https://api.fireflies.ai/graphql';

async function firefliesQuery(query: string, variables: Record<string, any> = {}): Promise<any> {
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) throw new Error(`Fireflies API: HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.errors) throw new Error(`Fireflies: ${data.errors[0]?.message}`);
  return data.data;
}

export async function gatherFireflies(): Promise<string> {
  if (!FIREFLIES_API_KEY) return '';

  const sections: string[] = [];

  try {
    // Get recent transcripts (last 24 hours)
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const data = await firefliesQuery(`
      query {
        transcripts(limit: 10) {
          id
          title
          date
          duration
          transcript_url
          meeting_attendees {
            displayName
            email
          }
          summary {
            action_items
            keywords
            short_summary
          }
        }
      }
    `);

    const transcripts = data?.transcripts || [];

    // Filter to today's meetings only
    const todayStr = now.toISOString().slice(0, 10);
    const todayMeetings = transcripts.filter((t: any) => {
      if (!t.date) return false;
      const meetingDate = new Date(Number(t.date)).toISOString().slice(0, 10);
      return meetingDate === todayStr;
    });

    if (todayMeetings.length === 0) {
      // Check yesterday too (for evening wraps where meetings just ended)
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      const recentMeetings = transcripts.filter((t: any) => {
        if (!t.date) return false;
        const meetingDate = new Date(Number(t.date)).toISOString().slice(0, 10);
        return meetingDate === todayStr || meetingDate === yesterdayStr;
      });

      if (recentMeetings.length === 0) {
        sections.push('### Meeting transcripts: no transcribed meetings found today');
        return sections.join('\n');
      }
    }

    const meetings = todayMeetings.length > 0 ? todayMeetings : transcripts.slice(0, 5);

    sections.push(`### Meeting transcripts (${meetings.length} meetings):`);

    for (const t of meetings) {
      const meetingDate = t.date ? new Date(Number(t.date)) : null;
      const dateStr = meetingDate
        ? meetingDate.toLocaleString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' })
        : 'unknown time';
      const durationMin = t.duration ? Math.round(t.duration / 60) : '?';
      const attendees = t.meeting_attendees?.map((a: any) => a.displayName || a.email).join(', ') || 'unknown';

      sections.push(`\n#### ${t.title || 'Untitled meeting'}`);
      sections.push(`Time: ${dateStr} | Duration: ${durationMin} min | Attendees: ${attendees}`);

      if (t.summary?.action_items) {
        sections.push(`Action items: ${t.summary.action_items}`);
      } else {
        sections.push('Action items: none identified');
      }

      if (t.summary?.keywords) {
        sections.push(`Key topics: ${t.summary.keywords}`);
      }

      if (t.transcript_url) {
        sections.push(`Full transcript: ${t.transcript_url}`);
      }
    }
  } catch (e: any) {
    sections.push(`[Fireflies error: ${e.message}]`);
  }

  return sections.join('\n') || '';
}
