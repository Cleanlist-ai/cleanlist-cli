import { type Command, confirmAction, list, requireArg } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;
const EVENTS = 'play_run.completed, play_run.failed, approval.needed, reply.received, enrichment.completed, job_change.detected, website_visit.detected';

export const webhookCommands: Command[] = [
  {
    name: 'webhooks list',
    summary: 'Your webhook subscriptions.',
    examples: ['cleanlist webhooks list'],
    view: { rows: (d) => d.webhooks, columns: ['webhook_id', 'url', 'events', 'created_at'] },
    async run(ctx) {
      return (await ctx.api.get('/api/v2/webhooks')).data;
    },
  },
  {
    name: 'webhooks add',
    args: '<https_url>',
    summary: 'Subscribe a public https URL to events. The signing secret is shown once.',
    options: { events: { type: 'string', multiple: true, desc: `Events, comma separated: ${EVENTS}.` } },
    examples: ['cleanlist webhooks add https://example.com/hooks/cleanlist --events play_run.completed,reply.received'],
    async run(ctx) {
      const url = ctx.args[0];
      const events = list(ctx.opts.events);
      if (!url || !events) throw new CliError(EXIT.USAGE, 'Pass the https URL and --events.', `Events: ${EVENTS}.`);
      const { data } = await ctx.api.post('/api/v2/webhooks', { url, events });
      ctx.log("Save the secret now: it is not shown again. Verify each delivery's Cleanlist-Signature header with it.");
      return data;
    },
  },
  {
    name: 'webhooks remove',
    args: '<webhook_id>',
    summary: 'Stop sending events to a subscription.',
    examples: ['cleanlist webhooks remove <webhook_id> --yes'],
    async run(ctx) {
      const id = requireArg(ctx, 'webhook_id', 'webhooks list');
      await confirmAction(ctx, `Remove webhook ${id}?`);
      return (await ctx.api.request('DELETE', `/api/v2/webhooks/${enc(id)}`)).data;
    },
  },
];
