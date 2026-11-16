import { type Command, intOpt } from '../context.js';
import { CliError, EXIT } from '../errors.js';

export const updateCommands: Command[] = [
  {
    name: 'updates',
    summary: "What's new: replies waiting, tasks due, finished agent and play runs, approvals waiting.",
    options: {
      since: { type: 'string', desc: 'An ISO time or a day (default: the last 24 hours). Pass the last answer\'s `until`.' },
      limit: { type: 'string', desc: 'At most this many of each kind (default 10, max 100).' },
    },
    examples: ['cleanlist updates', 'cleanlist updates --since 2026-11-10T09:00:00Z --json'],
    async run(ctx) {
      const limit = intOpt(ctx.opts.limit, 'limit');
      if (limit !== undefined && (limit < 1 || limit > 100)) throw new CliError(EXIT.USAGE, '--limit must be 1 to 100.');
      const { data } = await ctx.api.get('/api/v2/updates', { since: ctx.opts.since, limit });
      if (data?.until) ctx.log(`Next time: cleanlist updates --since ${data.until}`);
      return data;
    },
  },
];
