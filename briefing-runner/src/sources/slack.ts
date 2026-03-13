// ─── Slack Data Gatherer ────────────────────────────────────
// Uses Slack Web API with a Bot User OAuth Token (xoxb-...).
// Only uses bot-compatible endpoints (no search.messages — that
// requires a user token xoxp-).

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_ID = process.env.SLACK_USER_ID;

const BASE = 'https://slack.com/api';

async function slackGet(method: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${BASE}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`Slack ${method}: HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

export async function gatherSlack(): Promise<string> {
  if (!SLACK_BOT_TOKEN) return '';

  if (!SLACK_BOT_TOKEN.startsWith('xoxb-')) {
    throw new Error(
      `Invalid token format — must start with "xoxb-". ` +
      `Go to api.slack.com/apps → OAuth & Permissions → "Bot User OAuth Token".`
    );
  }

  const sections: string[] = [];

  // Get channels the bot is a member of and scan for recent activity
  try {
    const convos = await slackGet('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '20',
    });

    const channelSummaries: string[] = [];
    const mentionMessages: string[] = [];
    const cutoff = Math.floor(Date.now() / 1000) - 86400; // last 24h

    for (const ch of (convos.channels || []).slice(0, 15)) {
      if (!ch.is_member) continue;

      try {
        const history = await slackGet('conversations.history', {
          channel: ch.id,
          limit: '10',
          oldest: String(cutoff),
        });

        const msgs = (history.messages || []).filter(
          (m: any) => !m.subtype && m.text && m.text.length > 5
        );

        if (msgs.length > 0) {
          channelSummaries.push(`- #${ch.name}: ${msgs.length} messages in last 24h`);
        }

        // Check for @mentions of the user
        if (SLACK_USER_ID) {
          for (const m of msgs) {
            if (m.text?.includes(`<@${SLACK_USER_ID}>`)) {
              const preview = m.text
                .replace(/<@[A-Z0-9]+>/g, '@user')
                .slice(0, 100);
              mentionMessages.push(`- #${ch.name}: ${preview}`);
            }
          }
        }
      } catch {
        // Skip channels we can't read (permissions)
      }
    }

    if (mentionMessages.length) {
      sections.push(`### Your mentions (last 24h): ${mentionMessages.length}`);
      sections.push(...mentionMessages.slice(0, 8));
    } else {
      sections.push('### Your mentions: none in last 24h');
    }

    if (channelSummaries.length) {
      sections.push('\n### Active channels (last 24h):');
      sections.push(...channelSummaries);
    }
  } catch (e: any) {
    sections.push(`[Channels error: ${e.message}]`);
  }

  return sections.join('\n') || '';
}
