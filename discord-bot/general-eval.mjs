// The general channels' pointers against an export of them: the messages replayed in order, on their own clock, through
// General (general.mjs) with the real sorting model, and a report of every reply it would post (with what the author
// said) and of every author it sorted.  A day of chat costs a few cents.
//   node --env-file=.env general-eval.mjs <export.json> [--staff name,name] [--from 2026-10-26T12:00] [--to ...]
// export.json: [{ id, ch (channel name), t (ISO time), a (author's name), c (text), re: { a, c } (the message it replies
// to), att: [file names], bot }] (from a Discord export; it stays out of the repository: it holds players' messages).
// Pictures are not in it, so the sorting reads none.  The report goes next to it as general-eval-<time>.md.
import { ChannelType } from 'discord.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { General } from './general.mjs';
import { newClient } from './investigate.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args.splice(i, 2)[1]; };
const staff = new Set(opt('--staff', '').split(',').filter(Boolean));
const from = opt('--from', ''), to = opt('--to', '');
const file = args[0];
if (!file) { console.error('usage: general-eval.mjs <export.json> [--staff name,name] [--from ISO] [--to ISO]'); process.exit(2); }

const PRICE = [0.1, 0.5];                        // Haiku 5.5: $ per million tokens in, out
const hhmm = ms => new Date(ms).toISOString().slice(11, 16);
// the replies of the bot that was running then are left out: this run makes its own
const msgs = JSON.parse(fs.readFileSync(file, 'utf8'))
  .filter(x => !x.bot && (!from || x.t >= from) && (!to || x.t < to))
  .sort((a, b) => a.t.localeCompare(b.t));

let clock = 0;
const usage = { calls: 0, in: 0, out: 0 }, replies = [], log = [], seen = [];
const anthropic = newClient();
const counted = { messages: { create: async req => {
  const res = await anthropic.messages.create(req);
  usage.calls++; usage.in += res.usage.input_tokens; usage.out += res.usage.output_tokens;
  return res;
} } };
const general = new General({
  client: null, anthropic: counted, model: 'claude-sonnet-5-5', isStaff: member => staff.has(member?.id), staffChannel: '',
  dryRun: false, state: fs.mkdtempSync(path.join(os.tmpdir(), 'general-eval-')), releasedAt: () => 0,
  download: async () => null, forumThreads: () => [], bugForum: () => ({ id: 'bug-reports' }), now: () => clock,
});

const channels = new Map();
const channel = n => channels.get(n) ?? channels.set(n, { id: `#${n}`, name: n, type: ChannelType.GuildText }).get(n);
const user = n => ({ id: n, bot: false, username: n });

/** an export's message as discord.js gives it, as far as General reads it; its reply() posts the bot's message */
function message(x) {
  const ch = channel(x.ch);
  const ref = x.re && seen.findLast(y => y.ch === x.ch && y.a === x.re.a && (y.c ?? '').startsWith(x.re.c.slice(0, 40)));
  const att = (x.att ?? []).map(a => typeof a === 'string' ? { name: a } : a);
  return {
    id: x.id, channelId: ch.id, channel: ch, guildId: 'guild', guild: null, content: x.c ?? '',
    author: user(x.a), member: { id: x.a, displayName: x.a },
    attachments: new Map(att.map((a, i) => [String(i), { name: a.name, url: a.url ?? '', size: a.size ?? 0 }])),
    mentions: { repliedUser: x.re ? user(x.re.a) : null, users: new Map() },
    reference: ref ? { messageId: ref.id } : null,
    reply: async ({ content }) => {
      replies.push({ at: clock, to: x, content });
      general.onMessage({
        id: `bot-${replies.length}`, channelId: ch.id, channel: ch, guildId: 'guild', content, member: null,
        author: { id: 'bot', bot: true, username: 'NFS Helper' }, attachments: new Map(),
        mentions: { repliedUser: user(x.a), users: new Map() }, reference: { messageId: x.id },
      });
    },
  };
}

const print = console.log;
console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[general]')) log.push(`${hhmm(clock)} ${s}`); print(...a); };

let next = 0;                                    // the next minute's tick
const tickTo = async at => { while (next <= at) { clock = next; await general.tick(); next += 60_000; } };
for (const x of msgs) {
  const at = Date.parse(x.t);
  next ||= Math.ceil(at / 60_000) * 60_000;
  await tickTo(at);
  clock = at;
  general.onMessage(message(x));
  seen.push(x);
}
await tickTo(next + 10 * 60_000);                // the last messages' wait

const cost = (usage.in * PRICE[0] + usage.out * PRICE[1]) / 1e6;
const quote = s => s.replace(/\s+/g, ' ').slice(0, 300);
const report = [
  `# General channels: ${path.basename(file)}, ${msgs.length} messages, ${msgs[0]?.t.slice(0, 16)} to ${msgs.at(-1)?.t.slice(0, 16)}`, '',
  `${usage.calls} sorting calls, ${usage.in} tokens in, ${usage.out} out: $${cost.toFixed(3)}. Staff: ${[...staff].join(', ') || 'none'}.`, '',
  `## Replies (${replies.length})`, '',
  ...replies.flatMap(r => [
    `### ${hhmm(r.at)} #${r.to.ch}, to ${r.to.a}`, '',
    ...msgs.filter(x => x.a === r.to.a && x.ch === r.to.ch && Date.parse(x.t) > r.at - 15 * 60_000 && Date.parse(x.t) <= r.at)
      .map(x => `> ${hhmm(Date.parse(x.t))} ${quote(x.c ?? '')}${x.att?.length ? ` [${x.att.length} file(s)]` : ''}`),
    '', r.content.replace('<#bug-reports>', '#bug-reports'), '',
  ]),
  `## Sorted`, '', ...log.map(l => `- ${l}`), '',
];
const out = path.join(path.dirname(path.resolve(file)), `general-eval-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`);
fs.writeFileSync(out, report.join('\n'));
print(`${replies.length} replies, ${usage.calls} calls, $${cost.toFixed(3)}: ${out}`);
