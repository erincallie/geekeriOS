// ─── HubSpot CRM Data Gatherer ──────────────────────────────
// Uses HubSpot's REST API with a Private App access token.
// Reads: deals, tasks due, recent activity.

import type { BriefingType } from '../prompts.js';

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const BASE = 'https://api.hubapi.com';

async function hubGet(path: string): Promise<any> {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`HubSpot ${path}: ${resp.status}`);
  return resp.json();
}

export async function gatherHubSpot(briefingType: BriefingType): Promise<string> {
  if (!HUBSPOT_TOKEN) return '';

  const sections: string[] = [];

  // Recent deals (last 50, sorted by last modified)
  try {
    const deals = await hubGet(
      '/crm/v3/objects/deals?limit=50&properties=dealname,amount,dealstage,closedate,hs_lastmodifieddate&sorts=-hs_lastmodifieddate'
    );
    if (deals.results?.length) {
      sections.push('### Recent deals:');
      for (const d of deals.results.slice(0, 20)) {
        const p = d.properties;
        const amount = p.amount ? `$${Number(p.amount).toLocaleString()}` : 'no amount';
        sections.push(`- ${p.dealname} | Stage: ${p.dealstage} | ${amount} | Close: ${p.closedate || 'TBD'} | Modified: ${p.hs_lastmodifieddate}`);
      }
    }
  } catch (e: any) {
    sections.push(`[Deals error: ${e.message}]`);
  }

  // Pipeline summary (deal stages)
  try {
    const pipelines = await hubGet('/crm/v3/pipelines/deals');
    if (pipelines.results?.length) {
      const pipeline = pipelines.results[0];
      sections.push(`\n### Pipeline: ${pipeline.label}`);
      sections.push(`Stages: ${pipeline.stages?.map((s: any) => s.label).join(' → ')}`);
    }
  } catch (e: any) {
    sections.push(`[Pipeline error: ${e.message}]`);
  }

  // Tasks due today/this week
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(endOfWeek.getDate() + (briefingType.includes('monday') ? 7 : 1));

    const tasks = await hubGet(
      `/crm/v3/objects/tasks?limit=20&properties=hs_task_subject,hs_task_status,hs_task_priority,hs_timestamp&sorts=hs_timestamp`
    );
    if (tasks.results?.length) {
      const pending = tasks.results.filter((t: any) => t.properties.hs_task_status !== 'COMPLETED');
      if (pending.length) {
        sections.push('\n### Open tasks:');
        for (const t of pending.slice(0, 10)) {
          const p = t.properties;
          sections.push(`- ${p.hs_task_subject} | Priority: ${p.hs_task_priority || 'normal'} | Due: ${p.hs_timestamp || 'unset'}`);
        }
      }
    }
  } catch (e: any) {
    sections.push(`[Tasks error: ${e.message}]`);
  }

  return sections.join('\n') || '';
}
