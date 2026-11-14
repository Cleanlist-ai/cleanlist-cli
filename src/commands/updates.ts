import type { Command } from '../context.js';

export const updateCommands: Command[] = [
  {
    name: 'updates',
    summary: "What's new: replies waiting, tasks due, finished agent and play runs, approvals waiting.",
    options: { since: { type: 'string', desc: 'An ISO time or a day (default: the last 24 hours). Pass the last answer\'s `until`.' } },
    examples: ['cleanlist updates', 'cleanlist updates --since 2026-11-10T09:00:00Z --json'],
    async run(ctx) {
      const { data } = await ctx.api.get('/api/v2/updates', { since: ctx.opts.since });
      if (data?.until) ctx.log(`Next time: cleanlist updates --since ${data.until}`);
      return data;
    },
  },
];
