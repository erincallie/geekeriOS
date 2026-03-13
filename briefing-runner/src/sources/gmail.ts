// ─── Gmail Data Gatherer ────────────────────────────────────
// Uses Gmail REST API v1 with OAuth refresh token.
// Fetches: unread/flagged emails, emails needing a reply,
// and Work Context Protocol daily digest (priority item).

import { isGoogleConfigured, getGoogleAccessToken } from './google-auth.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailGet(path: string): Promise<any> {
  const token = await getGoogleAccessToken();
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Gmail ${path}: ${resp.status}`);
  return resp.json();
}

interface EmailSummary {
  subject: string;
  from: string;
  date: string;
  snippet: string;
  starred: boolean;
  body?: string;
}

async function getMessageSummary(messageId: string, includeBody = false): Promise<EmailSummary> {
  const format = includeBody ? 'full' : 'metadata';
  const metaHeaders = includeBody ? '' : '&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date';
  const msg = await gmailGet(`/messages/${messageId}?format=${format}${metaHeaders}`);

  const headers = (includeBody ? msg.payload?.headers : msg.payload?.headers) || [];
  const getHeader = (name: string) => headers.find((h: any) => h.name === name)?.value || '';

  // Clean up the "From" field to just show name
  let from = getHeader('From');
  const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
  if (nameMatch) from = nameMatch[1].trim();

  let body = '';
  if (includeBody) {
    // Extract plain text body from the message
    body = extractTextBody(msg.payload) || msg.snippet || '';
  }

  return {
    subject: getHeader('Subject') || '(no subject)',
    from,
    date: getHeader('Date'),
    snippet: msg.snippet || '',
    starred: msg.labelIds?.includes('STARRED') || false,
    body,
  };
}

// Recursively extract plain text from a MIME message
function extractTextBody(payload: any): string {
  if (!payload) return '';

  // Direct text/plain part
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart: recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      // Prefer text/plain
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      // Recurse into nested multipart
      const nested = extractTextBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

export async function gatherGmail(): Promise<string> {
  if (!isGoogleConfigured()) return '';

  const sections: string[] = [];

  // ─── PRIORITY: Work Context Protocol daily digest ──────────
  // WCP sends a daily email digest summarizing work item activity,
  // updates, and notifications. This should always be surfaced
  // prominently when present. The digest started March 13, 2026.
  try {
    const wcpResults = await gmailGet(
      `/messages?q=from:workcontextprotocol+OR+from:wcp+OR+subject:"work+context+protocol"+newer_than:2d&maxResults=3`
    );
    if (wcpResults.messages?.length) {
      sections.push('### 📌 Work Context Protocol digest:');
      const summaries = await Promise.all(
        wcpResults.messages.slice(0, 2).map((m: any) => getMessageSummary(m.id, true))
      );
      for (const s of summaries) {
        sections.push(`- "${s.subject}" (${s.date})`);
        // Include the digest body (truncated) so Claude can summarize it
        if (s.body) {
          const truncated = s.body.slice(0, 2000);
          sections.push(`  Content: ${truncated}${s.body.length > 2000 ? '... [truncated]' : ''}`);
        } else {
          sections.push(`  Snippet: ${s.snippet}`);
        }
      }
    } else {
      sections.push('### 📌 Work Context Protocol digest: none found in last 2 days');
    }
  } catch (e: any) {
    sections.push(`[WCP digest error: ${e.message}]`);
  }

  // ─── Unread emails in inbox ────────────────────────────────
  try {
    const unread = await gmailGet('/messages?q=is:unread+in:inbox&maxResults=15');
    const unreadCount = unread.resultSizeEstimate || 0;
    sections.push(`\n### Inbox: ~${unreadCount} unread emails`);

    if (unread.messages?.length) {
      sections.push('Top unread:');
      const summaries = await Promise.all(
        unread.messages.slice(0, 8).map((m: any) => getMessageSummary(m.id))
      );
      for (const s of summaries) {
        const star = s.starred ? '⭐ ' : '';
        sections.push(`- ${star}From: ${s.from} | "${s.subject}" | ${s.snippet.slice(0, 80)}...`);
      }
    }
  } catch (e: any) {
    sections.push(`[Unread error: ${e.message}]`);
  }

  // ─── Starred/flagged emails ────────────────────────────────
  try {
    const starred = await gmailGet('/messages?q=is:starred+in:inbox&maxResults=10');
    if (starred.messages?.length) {
      sections.push(`\n### Starred/flagged: ${starred.messages.length} messages`);
      const summaries = await Promise.all(
        starred.messages.slice(0, 5).map((m: any) => getMessageSummary(m.id))
      );
      for (const s of summaries) {
        sections.push(`- From: ${s.from} | "${s.subject}"`);
      }
    }
  } catch (e: any) {
    sections.push(`[Starred error: ${e.message}]`);
  }

  // ─── Emails needing a reply ────────────────────────────────
  try {
    const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const dateStr = `${cutoff.getFullYear()}/${cutoff.getMonth() + 1}/${cutoff.getDate()}`;
    const needsReply = await gmailGet(
      `/messages?q=is:unread+in:inbox+before:${dateStr}+-category:promotions+-category:social+-category:updates&maxResults=10`
    );
    if (needsReply.messages?.length) {
      sections.push(`\n### Possibly needs reply (unread > 4hrs):`);
      const summaries = await Promise.all(
        needsReply.messages.slice(0, 5).map((m: any) => getMessageSummary(m.id))
      );
      for (const s of summaries) {
        sections.push(`- From: ${s.from} | "${s.subject}"`);
      }
    }
  } catch (e: any) {
    sections.push(`[Needs-reply error: ${e.message}]`);
  }

  return sections.join('\n') || '';
}
