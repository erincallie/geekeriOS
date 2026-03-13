// ─── Google Drive Data Gatherer ──────────────────────────────
// Lists recently modified files across all of Drive.
// Used in Monday briefings to surface active documents.
// Requires 'drive.metadata.readonly' scope in OAuth token.

import { isGoogleConfigured, getGoogleAccessToken } from './google-auth.js';

const BASE = 'https://www.googleapis.com/drive/v3';

async function driveGet(path: string): Promise<any> {
  const token = await getGoogleAccessToken();
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Drive ${path}: ${resp.status} ${body.slice(0, 200)}`);
  }
  return resp.json();
}

export async function gatherDrive(lookbackDays = 7): Promise<string> {
  if (!isGoogleConfigured()) return '';

  const sections: string[] = [];

  try {
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);
    const sinceStr = since.toISOString();

    // List recently modified files (not trashed, not folders)
    const params = new URLSearchParams({
      q: `modifiedTime > '${sinceStr}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      orderBy: 'modifiedTime desc',
      pageSize: '20',
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners,lastModifyingUser)',
    });

    const result = await driveGet(`/files?${params}`);
    const files = result.files || [];

    if (files.length === 0) {
      sections.push(`### Google Drive: no files modified in the last ${lookbackDays} days`);
      return sections.join('\n');
    }

    // Group by type
    const docTypes: Record<string, string> = {
      'application/vnd.google-apps.document': 'Doc',
      'application/vnd.google-apps.spreadsheet': 'Sheet',
      'application/vnd.google-apps.presentation': 'Slides',
      'application/vnd.google-apps.form': 'Form',
      'application/pdf': 'PDF',
    };

    sections.push(`### Google Drive: ${files.length} files modified in the last ${lookbackDays} days:`);

    for (const f of files) {
      const type = docTypes[f.mimeType] || 'File';
      const modified = new Date(f.modifiedTime).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        timeZone: 'America/Denver',
      });
      const modifiedBy = f.lastModifyingUser?.displayName || 'unknown';

      sections.push(`- [${type}] ${f.name} | Modified ${modified} by ${modifiedBy}`);
    }
  } catch (e: any) {
    // Check if the error is a scope issue
    if (e.message.includes('403') || e.message.includes('insufficientPermissions')) {
      sections.push(
        `[Google Drive error: missing scope — re-authorize in OAuth Playground with drive.metadata.readonly]`
      );
    } else {
      sections.push(`[Google Drive error: ${e.message}]`);
    }
  }

  return sections.join('\n') || '';
}
