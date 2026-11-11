import { randomUUID } from 'node:crypto';
import { type Command, type Ctx, intOpt, readInput, sendApproved } from '../context.js';
import { CliError, EXIT } from '../errors.js';

const enc = encodeURIComponent;
const STATUSES = ['open', 'needs_reply', 'snoozed', 'done'];

function threadId(ctx: Ctx): string {
  const id = ctx.args[0];
  if (!id) throw new CliError(EXIT.USAGE, 'Pass the thread id.', 'See `cleanlist inbox list`.');
  return id;
}

export const inboxCommands: Command[] = [
  {
    name: 'inbox list',
    summary: 'Inbox conversations (replies to your sequences), newest first.',
    options: {
      status: { type: 'string', desc: 'open (default), needs_reply, snoozed or done (archived).' },
      since: { type: 'string', desc: 'Only conversations active since this day, YYYY-MM-DD.' },
      q: { type: 'string', desc: 'Text in a name, address, company, subject or message.' },
      limit: { type: 'string', desc: 'At most this many (default 50, max 200).' },
      offset: { type: 'string', desc: 'Skip this many (next page).' },
    },
    examples: ['cleanlist inbox list --status needs_reply', 'cleanlist inbox list --since 2026-11-09 --json'],
    view: { rows: (d) => d.threads, columns: ['id', 'name', 'email', 'company', 'subject', 'last_message_at', 'needs_reply'] },
    async run(ctx) {
      const status = ctx.opts.status;
      if (status !== undefined && !STATUSES.includes(status)) throw new CliError(EXIT.USAGE, `--status must be one of ${STATUSES.join(', ')}.`);
      const since = ctx.opts.since;
      if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new CliError(EXIT.USAGE, 'Pass --since as YYYY-MM-DD.');
      const query = { status, since, q: ctx.opts.q, limit: intOpt(ctx.opts.limit, 'limit'), offset: intOpt(ctx.opts.offset, 'offset') };
      return (await ctx.api.get('/api/v2/inbox/threads', query)).data;
    },
  },
  {
    name: 'inbox read',
    args: '<thread_id>',
    summary: 'One conversation, every message in order.',
    examples: ['cleanlist inbox read <thread_id>'],
    async run(ctx) {
      return (await ctx.api.get(`/api/v2/inbox/threads/${enc(threadId(ctx))}`)).data;
    },
  },
  {
    name: 'inbox reply',
    args: '<thread_id>',
    summary: 'Reply to the lead from the address the Inbox replies from. Emails a real person: asks first.',
    paid: true,
    options: {
      body: { type: 'string', desc: 'The reply text.' },
      'body-file': { type: 'string', desc: 'Read the reply text from this file ("-" for stdin).' },
    },
    examples: ['cleanlist inbox reply <thread_id> --body "Thanks, Tuesday at 2 works."', 'cleanlist inbox reply <thread_id> --body-file reply.txt --yes'],
    async run(ctx) {
      const id = threadId(ctx);
      if ((ctx.opts.body === undefined) === (ctx.opts['body-file'] === undefined)) throw new CliError(EXIT.USAGE, 'Pass --body or --body-file (one of them).');
      const text = String(ctx.opts.body ?? readInput(ctx.opts['body-file']));
      if (!text.trim()) throw new CliError(EXIT.USAGE, 'The reply is empty.');
      // One id for this reply, so a retried send gets the reply already sent back and sends nothing.
      return sendApproved(ctx, `/api/v2/inbox/threads/${enc(id)}/reply`, { body: text, request_id: randomUUID() });
    },
  },
  {
    name: 'inbox done',
    args: '<thread_id>',
    summary: 'Archive a conversation and close its Reply task.',
    examples: ['cleanlist inbox done <thread_id>'],
    async run(ctx) {
      return (await ctx.api.request('PATCH', `/api/v2/inbox/threads/${enc(threadId(ctx))}`, { body: { status: 'done' } })).data;
    },
  },
];
