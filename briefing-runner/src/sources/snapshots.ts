// ─── Metric Snapshots ───────────────────────────────────────
// Saves daily pipeline metrics to a JSON file for week-over-week
// comparison in Friday retros.
//
// File: briefing-runner/data/metric-snapshots.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const DATA_DIR = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'data');
const SNAPSHOTS_FILE = join(DATA_DIR, 'metric-snapshots.json');

interface DailySnapshot {
  date: string;          // YYYY-MM-DD
  dealsOpen: number;
  dealsClosed: number;
  pipelineValue: number;
  tasksOpen: number;
  tasksCompleted: number;
  dealsInNegotiation: number;
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadSnapshots(): DailySnapshot[] {
  ensureDataDir();
  if (!existsSync(SNAPSHOTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SNAPSHOTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveSnapshots(snapshots: DailySnapshot[]) {
  ensureDataDir();
  // Keep last 60 days max
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const trimmed = snapshots.filter(s => s.date >= cutoffStr);
  writeFileSync(SNAPSHOTS_FILE, JSON.stringify(trimmed, null, 2));
}

/** Save today's metrics snapshot */
export function saveDailySnapshot(metrics: Omit<DailySnapshot, 'date'>) {
  const today = new Date().toISOString().slice(0, 10);
  const snapshots = loadSnapshots();

  // Replace today's snapshot if it already exists
  const existing = snapshots.findIndex(s => s.date === today);
  const snapshot = { date: today, ...metrics };

  if (existing >= 0) {
    snapshots[existing] = snapshot;
  } else {
    snapshots.push(snapshot);
  }

  saveSnapshots(snapshots);
  console.log(`  📸 Saved metric snapshot for ${today}`);
}

/** Get comparison data for the Friday retro */
export function getWeeklyComparison(): string {
  const snapshots = loadSnapshots();
  if (snapshots.length < 2) {
    return '### Weekly metrics comparison: not enough data yet (need at least 2 snapshots)';
  }

  const sorted = [...snapshots].sort((a, b) => b.date.localeCompare(a.date));

  // This week's snapshots (last 5 weekdays)
  const thisWeek = sorted.slice(0, 5);
  // Last week's snapshots (next 5)
  const lastWeek = sorted.slice(5, 10);

  if (lastWeek.length === 0) {
    // Only have one week of data — show just this week
    const latest = thisWeek[0];
    return [
      '### Weekly metrics snapshot:',
      `- Deals open: ${latest.dealsOpen}`,
      `- Pipeline value: $${latest.pipelineValue.toLocaleString()}`,
      `- Deals in negotiation: ${latest.dealsInNegotiation}`,
      `- Tasks open: ${latest.tasksOpen}`,
      `(Week-over-week comparison will be available next week)`,
    ].join('\n');
  }

  // Aggregate this week vs last week
  const thisWeekLatest = thisWeek[0];
  const lastWeekLatest = lastWeek[0];

  const delta = (current: number, previous: number): string => {
    const diff = current - previous;
    const pct = previous > 0 ? Math.round((diff / previous) * 100) : 0;
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    return `${current} (${arrow} ${Math.abs(diff)}, ${pct >= 0 ? '+' : ''}${pct}%)`;
  };

  return [
    '### Weekly metrics comparison (this week vs last week):',
    `- Deals open: ${delta(thisWeekLatest.dealsOpen, lastWeekLatest.dealsOpen)}`,
    `- Pipeline value: $${thisWeekLatest.pipelineValue.toLocaleString()} vs $${lastWeekLatest.pipelineValue.toLocaleString()}`,
    `- Deals in negotiation: ${delta(thisWeekLatest.dealsInNegotiation, lastWeekLatest.dealsInNegotiation)}`,
    `- Tasks open: ${delta(thisWeekLatest.tasksOpen, lastWeekLatest.tasksOpen)}`,
  ].join('\n');
}

/** Parse HubSpot data string to extract metrics for snapshotting */
export function parseHubSpotMetrics(hubspotData: string): Omit<DailySnapshot, 'date'> | null {
  try {
    const deals = (hubspotData.match(/^- .+\| Stage: .+/gm) || []);
    const closedDeals = deals.filter(d => /closedwon|closed won/i.test(d));
    const negotiationDeals = deals.filter(d => /negotiat|contract/i.test(d));

    // Extract pipeline value from deal amounts
    let totalValue = 0;
    for (const deal of deals) {
      const amountMatch = deal.match(/\$([0-9,]+)/);
      if (amountMatch) {
        totalValue += parseInt(amountMatch[1].replace(/,/g, ''), 10) || 0;
      }
    }

    const openTasks = (hubspotData.match(/^- .+\| Priority: /gm) || []).length;

    return {
      dealsOpen: deals.length,
      dealsClosed: closedDeals.length,
      pipelineValue: totalValue,
      tasksOpen: openTasks,
      tasksCompleted: 0, // Can't determine from a single snapshot
      dealsInNegotiation: negotiationDeals.length,
    };
  } catch {
    return null;
  }
}
