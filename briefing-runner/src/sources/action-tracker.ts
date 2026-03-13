// ─── Action Item Tracker ────────────────────────────────────
// Persists action items to a local JSON file between briefing runs.
// Morning briefings read open items; evening briefings write new ones.
//
// File: briefing-runner/data/action-items.json
// Format: Array of { id, text, source, createdAt, completedAt?, status }
//
// Future: Push to WCP work items when API auth is configured.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const DATA_DIR = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'data');
const ITEMS_FILE = join(DATA_DIR, 'action-items.json');

interface ActionItem {
  id: string;
  text: string;
  source: string;       // 'briefing', 'fireflies', 'email', 'hubspot'
  createdAt: string;     // ISO date
  dueDate?: string;
  completedAt?: string;
  status: 'open' | 'done' | 'stale';
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadItems(): ActionItem[] {
  ensureDataDir();
  if (!existsSync(ITEMS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(ITEMS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveItems(items: ActionItem[]) {
  ensureDataDir();
  writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2));
}

// Generate a short unique ID
function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Public API ──────────────────────────────────────────────

/** Get open action items for the morning briefing */
export function getOpenItems(): string {
  const items = loadItems();
  const open = items.filter(i => i.status === 'open');

  if (open.length === 0) return '';

  // Mark items older than 7 days as stale
  const now = Date.now();
  const staleThreshold = 7 * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const item of open) {
    if (now - new Date(item.createdAt).getTime() > staleThreshold) {
      item.status = 'stale';
      changed = true;
    }
  }
  if (changed) saveItems(items);

  const activeOpen = items.filter(i => i.status === 'open');
  const stale = items.filter(i => i.status === 'stale');

  const sections: string[] = [];

  if (activeOpen.length) {
    sections.push(`### Open action items (${activeOpen.length}):`);
    for (const item of activeOpen) {
      const age = Math.floor((now - new Date(item.createdAt).getTime()) / (24 * 60 * 60 * 1000));
      const due = item.dueDate ? ` | Due: ${item.dueDate}` : '';
      sections.push(`- [${item.source}] ${item.text} (${age}d old${due})`);
    }
  }

  if (stale.length) {
    sections.push(`\n### Stale items (>7 days old, ${stale.length}):`);
    for (const item of stale.slice(0, 5)) {
      sections.push(`- [${item.source}] ${item.text}`);
    }
  }

  return sections.join('\n');
}

/** Save new action items from the evening briefing */
export function saveActionItems(items: Array<{ text: string; source: string; dueDate?: string }>) {
  const existing = loadItems();

  // Deduplicate: skip items with very similar text
  const newItems: ActionItem[] = [];
  for (const item of items) {
    const isDuplicate = existing.some(e =>
      e.status === 'open' &&
      e.text.toLowerCase().includes(item.text.toLowerCase().slice(0, 30))
    );
    if (!isDuplicate) {
      newItems.push({
        id: newId(),
        text: item.text,
        source: item.source,
        createdAt: new Date().toISOString(),
        dueDate: item.dueDate,
        status: 'open',
      });
    }
  }

  if (newItems.length > 0) {
    saveItems([...existing, ...newItems]);
    console.log(`  📝 Saved ${newItems.length} new action items`);
  }
}

/** Mark items as done by partial text match */
export function completeItems(textMatches: string[]) {
  const items = loadItems();
  let completed = 0;

  for (const match of textMatches) {
    const lower = match.toLowerCase();
    for (const item of items) {
      if (item.status === 'open' && item.text.toLowerCase().includes(lower)) {
        item.status = 'done';
        item.completedAt = new Date().toISOString();
        completed++;
      }
    }
  }

  if (completed > 0) {
    saveItems(items);
    console.log(`  ✅ Completed ${completed} action items`);
  }
}

/** Clean up old completed/stale items (keep last 30 days) */
export function pruneItems() {
  const items = loadItems();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const kept = items.filter(i =>
    i.status === 'open' || new Date(i.createdAt).getTime() > cutoff
  );
  if (kept.length < items.length) {
    saveItems(kept);
    console.log(`  🧹 Pruned ${items.length - kept.length} old items`);
  }
}
