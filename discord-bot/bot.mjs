// The forum bot: reads every channel it can see (archive.mjs), and answers only in forum threads, where a new post
// gets one look (investigate.mjs) once its author has stopped adding to it.  It says something only when it has a
// verified fix or needs information the post lacks; after it asked, the author's next post gets one more look.  It
// stays out of threads the staff answered and stops after BOT_MAX_REPLIES replies in a thread.  A report the developer
// should act on goes to the staff channel (BOT_STAFF_CHANNEL): a post that says where the problem stands, with a thread
// for the part to copy to Claude, the files and every update (later threads about it, new logs).  When a release goes live,
// threads whose problem one of its commits fixes get a look ('fix live'), and a careful "may be fixed, reload" when the
// look is sure; suggestions one of its commits carries out, also old ones, get 'implemented': "added, reload", Complete.
//   node --env-file=.env bot.mjs        (settings: README.md)
import { ChannelType, Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.mjs';
import { matchFeatures, matchFixes } from './fixes.mjs';
import { General } from './general.mjs';
import { blocks, investigate, newClient, picture, vet } from './investigate.mjs';
import { Repo, defaultSource } from './repo.mjs';
import { Spend, metered } from './spend.mjs';
import { Tags } from './tags.mjs';
import { COMMAND as TRANSLATE, Translator } from './translate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const list = s => (s ?? '').split(/[\s,]+/).filter(Boolean);
const CFG = {
  token: env.DISCORD_TOKEN,
  forums: list(env.BOT_FORUMS),                  // forum channel ids; empty: every forum
  staff: list(env.BOT_STAFF),                    // user or role ids, besides the owner and whoever can manage threads
  staffChannel: env.BOT_STAFF_CHANNEL || '',     // where reports for the developer go; empty: nowhere (verdicts.jsonl only)
  model: env.BOT_MODEL || 'claude-sonnet-5-5',
  effort: env.BOT_EFFORT || 'medium',
  dryRun: env.BOT_DRY_RUN === '1',
  waitS: Number(env.BOT_WAIT_S || 120),
  maxReplies: Number(env.BOT_MAX_REPLIES || 2),
  maxTalk: Number(env.BOT_MAX_TALK || 6),        // replies per thread in all, answering people who reply to the bot
  budget: Number(env.BOT_BUDGET || 200),         // $ a month (UTC) for every model call; the looks wait when it runs short
  minConfidence: env.BOT_MIN_CONFIDENCE || 'medium',
  archive: env.BOT_ARCHIVE !== '0',
  state: path.resolve(HERE, env.BOT_STATE || 'state'),
  repo: env.BOT_REPO || defaultSource(HERE),
  branch: env.BOT_BRANCH || 'main',
  liveUrl: env.BOT_LIVE_URL || 'https://nfsu2.xyz/game.json', liveFile: env.BOT_LIVE_FILE || '/live/nfsu2.json',
};
if (!CFG.token) { console.error('DISCORD_TOKEN is not set (README.md)'); process.exit(2); }

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_TEXT = 10 << 20, MAX_IMAGE = 10 << 20, MAX_IMAGES = 4;   // pictures are shrunk for the model (picture())
const MAX_UPLOAD = 8 << 20, MAX_UPLOADS = 10;   // files copied into a staff report, each update (Discord takes 10 MB a file)
const MESSAGE_FILES = 10, MESSAGE_BYTES = 20 << 20;   // a message carries 10 files, 25 MB in all
const SAVES_ZIP = /^nfsu2-saves-.*\.zip$/i;      // Saves, Download backup: for the developer, not for the model
const LOG_FILE = /\.(log|txt)$/i;                // F9, Download log; a long paste comes as message.txt
const hasLog = m => [...m.attachments.values()].some(a => LOG_FILE.test(a.name));
/** a message that mentions the bot or replies to one of its messages (also with the reply's ping turned off) */
const toBot = m => m.mentions.repliedUser?.id === client.user.id ||
  m.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
const MAX_WAIT_MS = 10 * 60_000;                 // a thread that keeps growing is looked at after 10 minutes anyway
const STARTUP_MS = 48 * 3600_000;                // at start, the forums' posts of the last 48 hours, nothing older
const RELEASE_CHECK_MS = 5 * 60_000;             // how often the bot checks whether a new version went live
const FIX_DAYS = 14, FIX_MAX = 3;                // a release is checked against threads of the last 14 days, 3 looks at most
const FIX_EFFORT = 'low', FIX_TURNS = 8;          // a fix check reads one commit against one thread: a short look
const FEATURE_MAX = 5;                           // a release is checked against every open suggestion, 5 looks at most
const SUGGESTIONS = /suggest/i;                  // the suggestion forums, by name
const SUGGESTION_INDEX = 500;                    // a release reads the newest 500 archived threads of each of them
const SUGGESTION_DAYS = 365;                     // suggestions are kept in threads.json this long, other threads 30 days
const BUMP_QUIET_MS = 12 * 3600_000;             // the poster writing after this long a silence is a bump: they wait

fs.mkdirSync(CFG.state, { recursive: true });
const STATE_FILE = path.join(CFG.state, 'threads.json');
const VERDICTS = path.join(CFG.state, 'verdicts.jsonl');
const LIVE_FILE = path.join(CFG.state, 'live.json');      // the live version the bot saw last
/** per thread: { title, forum, guild, created, active, status: new|seen|none|asked|answered|staff|failed, replies,
 *  summary, category, snippet (its first post, for threads the bot only indexed), closed (archived, locked or deleted:
 *  not one to point people to); for a problem reported to the staff:
 *  staffMsg, staffThread (the report and its thread), report (on the first one: what its post shows, REPORT below),
 *  reportOf (on the later ones: the first thread's id) } */
let threads = {};
try { threads = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first start */ }
function save() {
  const cut = Date.now() - 30 * 86400_000, wishCut = Date.now() - SUGGESTION_DAYS * 86400_000;
  for (const [id, t] of Object.entries(threads)) if (Date.parse(t.created) < (isSuggestion(t) ? wishCut : cut)) delete threads[id];
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(threads, null, 1));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

const archive = CFG.archive ? new Archive(path.join(CFG.state, 'archive')) : null;
const repo = new Repo({ source: CFG.repo, branch: CFG.branch, dir: path.join(CFG.state, 'repo'), liveUrl: CFG.liveUrl, liveFile: CFG.liveFile,
  releasesFile: path.join(CFG.state, 'releases.json') });
const spend = new Spend(path.join(CFG.state, 'spend.json'), CFG.budget);
const anthropic = metered(newClient(), c => spend.add(c));
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const isForum = ch => ch?.type === ChannelType.GuildForum || ch?.type === ChannelType.GuildMedia;
/** a known thread that suggests something: in a suggestion forum, or one the look called a suggestion */
function isSuggestion(t) { return t.category === 'suggestion' || SUGGESTIONS.test(t.forum ?? ''); }
function watched(thread) {
  return thread?.isThread() && isForum(thread.parent) && (!CFG.forums.length || CFG.forums.includes(thread.parentId));
}
function isStaff(member, channel) {
  if (!member) return false;
  if (member.id === member.guild.ownerId || CFG.staff.includes(member.id)) return true;
  if (member.roles?.cache?.some(r => CFG.staff.includes(r.id))) return true;
  return !!channel && member.permissionsIn(channel).has(PermissionFlagsBits.ManageThreads);
}

const translator = new Translator({ client, anthropic, state: CFG.state });   // Apps, Translate on a message
const tags = new Tags({ client, anthropic, isStaff, dryRun: CFG.dryRun, onSolved: solved });   // forum tags (tags.mjs)

// the general channels (general.mjs): nudges to the forums, spikes and a daily digest for the staff
const general = new General({
  client, anthropic, model: CFG.model, isStaff, staffChannel: CFG.staffChannel, dryRun: CFG.dryRun, state: CFG.state,
  releasedAt: () => repo.releases.at(-1)?.at ?? 0, download,
  bugForum: guild => guild?.channels.cache.find(ch => isForum(ch) && /bug/i.test(ch.name)) ?? null,
  forumThreads: () => Object.entries(threads)
    .filter(([, t]) => !t.closed && !isSuggestion(t))
    .sort(byActivity).slice(0, 40)
    .map(([id, t]) => ({ id, line: `${id} | ${t.title} | ${(t.summary || t.snippet || '').slice(0, 120)}` })),
});

// ---------------------------------------------------------------------------------------------- when to look --
const timers = new Map();                        // thread id -> { timer, first }
const queue = [];
let busy = false;
function schedule(threadId, why) {
  const now = Date.now();
  const t = timers.get(threadId);
  if (t) clearTimeout(t.timer);
  if (why === 'asked by staff') {                // staff asked: no wait, and ahead of the other looks
    timers.delete(threadId);
    console.log(`[bot] ${threadId} "${threads[threadId]?.title}": asked by staff, looking now`);
    return enqueue(threadId, why, undefined, true);
  }
  const first = t?.first ?? now;
  const delay = Math.max(0, Math.min(CFG.waitS * 1000, first + MAX_WAIT_MS - now));
  if (!t) console.log(`[bot] ${threadId} "${threads[threadId]?.title}": ${why}, a look in ${Math.round(delay / 1000)} s unless more comes`);
  timers.set(threadId, { first, why, timer: setTimeout(() => { timers.delete(threadId); enqueue(threadId, why); }, delay) });
}
function enqueue(threadId, why, extra, first = false) {
  const queued = queue.findIndex(q => q.threadId === threadId);
  if (queued >= 0 && first) queue.splice(queued, 1);
  if (queued < 0 || first) queue[first ? 'unshift' : 'push']({ threadId, why, extra });
  pump();
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    try { await look(job.threadId, job.why, job.extra); } catch (e) { console.error(`[bot] ${job.threadId}: ${e.stack || e}`); }
  }
  busy = false;
}

/** at the turn of the UTC day (and at start): the looks the budget put off (st.later), oldest first; a thread with a look
 *  on its way already gets that one */
function lookLater() {
  const later = Object.entries(threads).filter(([, t]) => t.later).sort((a, b) => a[1].later.at.localeCompare(b[1].later.at));
  for (const [id, t] of later) {
    if (!timers.has(id)) enqueue(id, t.later.why, t.later.extra);
    delete t.later;
  }
  if (later.length) { console.log(`[bot] ${later.length} look(s) the budget put off, now`); save(); }
  const next = new Date(); next.setUTCHours(24, 0, 5, 0);
  setTimeout(lookLater, next - Date.now());
}

// ---------------------------------------------------------------------------------------------------- a look --
async function look(threadId, why, extra) {
  const thread = await client.channels.fetch(threadId).catch(() => null);
  const st = threads[threadId];
  const say = s => console.log(`[look] ${threadId} ${s}`);
  if (!thread || !st || !watched(thread)) return say('skipped: the thread is gone or not in a watched forum');
  const fix = why === 'fix live' || why === 'implemented';      // a release's look: a fix, or a suggestion it adds
  if (thread.locked || (thread.archived && !fix)) return say('skipped: closed or locked');
  st.guild ??= thread.guildId;
  const byStaff = why === 'asked by staff', bumped = why === 'bump', logged = why === 'log', talk = why === 'reply';
  // looks that go ahead where staff wrote and past the reply cap; replies to the bot up to their own cap
  const anyway = byStaff || fix || bumped || logged || talk;
  if (fix && st.fixed) return say(`skipped: already told that ${why === 'implemented' ? 'it was added' : 'a fix went live'}`);
  if (why === 'implemented' && Tags.decided(thread)) return say('skipped: the suggestion is Complete or Denied already');
  if (talk && st.replies >= CFG.maxTalk) return say(`skipped: ${st.replies} replies already, the most for answering replies`);
  if (!anyway && st.status === 'staff') return say('skipped: staff are in the thread');
  if (!anyway && st.replies >= CFG.maxReplies) return say(`skipped: ${st.replies} replies already`);
  // staff asked: a look past the budget too.  Any other waits for the next day
  if (!byStaff && !spend.allows()) {
    st.later = { why, ...(extra ? { extra } : {}), at: new Date().toISOString() }; save();
    return say(`skipped: today's $${spend.share().toFixed(2)} of the budget is spent, a look after midnight UTC`);
  }
  delete st.later;

  const msgs = [...(await thread.messages.fetch({ limit: 100 })).values()].reverse();
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter && !msgs.some(m => m.id === starter.id)) msgs.unshift(starter);
  if (!anyway && msgs.some(m => m.author.id !== client.user.id && isStaff(m.member, thread))) {
    st.status = 'staff'; save();
    return say('skipped: staff are in the thread');
  }
  const bump = bumped && openBump(msgs.filter(m => !m.system), thread.ownerId);
  if (bumped && (!bump || st.bump === bump.id)) return say('skipped: the bump was answered already');

  const workDir = path.join(CFG.state, 'work', threadId), staffDir = `${workDir}-staff`;
  for (const d of [workDir, staffDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const { text, images } = await transcript(thread, msgs.filter(m => !m.system), workDir, staffDir, why, extra);
  say(`"${st.title}" (${why}): ${msgs.length} message(s), ${fs.readdirSync(workDir).length} file(s), ` +
    `${fs.readdirSync(staffDir).filter(f => SAVES_ZIP.test(f.replace(/^\d+-/, ''))).length} save backup(s), ${images.length} picture(s)` +
    `${images.length ? ` (${images.reduce((s, p) => s + (p.tokens ?? 0), 0)} tokens)` : ''}`);

  const started = Date.now();
  // staff are waiting for this one: "typing…" in the thread until the reply is there (Discord shows it ~10 s a call)
  const typing = byStaff && setInterval(() => thread.sendTyping().catch(() => {}), 8000);
  if (typing) thread.sendTyping().catch(() => {});
  let res;
  try {
    res = await investigate({
      client: anthropic, model: CFG.model, effort: fix ? FIX_EFFORT : CFG.effort, maxTurns: fix ? FIX_TURNS : undefined, repo, archive, workDir,
      thread: text, images, threads: recentThreads(threadId), threadIndex: () => threadIndex(threadId), step: say,
    });
  } catch (e) {
    if (!byStaff) { clearInterval(typing); throw e; }
    res = { verdict: null, turns: 0, cost: 0, log: [`failed: ${e.message}`] };
    say(`failed: ${e.message}`);
  }
  const v = res.verdict;
  // a poster who brought what the bot asked for, or who bumped, always hears back
  let { post, why: outcome } = fix && v?.action !== 'answer' ? { post: null, why: v?.action ?? 'no verdict' }
    : vet(v, { minConfidence: fix ? 'high' : byStaff || bumped || why === 'follow-up' ? 'low' : CFG.minConfidence });
  if (byStaff && !post) {                        // staff asked: always a reply, at least what the look found
    const text = v ? `${v.summary}` : 'I could not finish a look at this thread just now; the developer has the details.';
    post = vet({ ...(v ?? {}), action: 'answer', confidence: 'high', reply: text }, {}).post;
    outcome = `${outcome}, replying for staff`;
  }
  const posted = post && (!CFG.dryRun || byStaff);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  say(`done: ${outcome}${posted ? ', posted in the thread' : post ? ', dry run (to the staff channel)' : ', nothing posted'}; ` +
    `${res.turns} turns, ${secs} s${res.cost != null ? `, $${res.cost.toFixed(3)}` : ''}`);
  if (post) say(`reply: ${post.split('\n')[0].slice(0, 160)}`);

  if (posted) {
    // a reply to the poster's last post once the bot replied before; to the log it read, or to who talked to it, when
    // that brought it here
    const newest = [...msgs].reverse();
    const ref = (logged && newest.find(m => hasLog(m) && !isStaff(m.member, thread))) ||
      (talk && newest.find(m => m.author.id !== client.user.id && toBot(m))) ||
      (st.replies && newest.find(m => m.author.id === thread.ownerId));
    try {
      for (const [n, content] of blocks(post).entries()) {    // a long reply: several messages, split between its parts
        await thread.send({
          content, allowedMentions: { parse: [], repliedUser: false },
          ...(n === 0 && ref ? { reply: { messageReference: ref.id, failIfNotExists: false } } : {}),
        });
      }
    } finally { clearInterval(typing); }
  }
  clearInterval(typing);
  if (fix) {                                     // a fix notice changes nothing else about the thread
    st.fixChecked = extra.rev;
    if (post) st.fixed = extra.rev;
    if (posted) await thread.fetch(true).catch(() => {});      // the reply took it out of the archive
    const added = why === 'implemented';
    if (post) await tags.add(thread, added ? 'complete' : 'fixLive').catch(e => console.error(`[tags] ${threadId}: ${e.message}`));
    if (post && CFG.staffChannel && st.staffMsg) {     // the report: fixed
      const staff = await client.channels.fetch(CFG.staffChannel).catch(() => null);
      const told = `${CFG.dryRun ? 'would have told' : 'told'} ${linkOf(thread.guildId, thread.id)}`;
      const that = `that ${added ? 'it was added' : 'it may be fixed'}`;
      const label = added ? 'Added' : 'Fix live', commit = `\`${extra.commit}\` ${extra.subject ?? ''}`.trim();
      const at = (repo.releases.find(r => r.rev === extra.rev)?.at ?? Date.now()) / 1000;
      if (staff) await reportUpdate(staff, st.reportOf ?? threadId, {
        line: `**${label}**: ${commit}; the bot ${told}`, content: `**${label}**: ${commit}\nThe bot ${told} ${that}.`,
        part: `${label}: ${commit}. The bot ${told} ${that}.`, fix: { commit: extra.commit, at: Math.floor(at), added },
      }).catch(e => console.error(`[staff] ${threadId}: ${e.message}`));
    }
    if (!posted && post && CFG.staffChannel) await tellStaff(thread, st, { ...v, escalate: false, duplicate_of: '' }, post, [workDir, staffDir], posted).catch(() => {});
    save();
    fs.appendFileSync(VERDICTS, JSON.stringify({ at: new Date().toISOString(), thread: threadId, title: st.title, why, extra, outcome,
      dryRun: CFG.dryRun, post, verdict: v, turns: res.turns, cost: res.cost, usage: res.usage, tools: res.log }) + '\n');
    for (const d of [workDir, staffDir]) fs.rmSync(d, { recursive: true, force: true });
    return;
  }
  if (post) st.replies++;
  if (bump) st.bump = bump.id;
  if (v) Object.assign(st, { summary: v.summary, category: v.category });
  if (!((bumped || logged || talk) && st.status === 'staff')) {   // a thread staff wrote in stays theirs
    st.status = !v ? 'failed' : post ? (v.action === 'ask' ? 'asked' : 'answered') : st.status === 'asked' ? 'asked-none' : 'none';
  }
  if (v && CFG.staffChannel) await tellStaff(thread, st, v, post, [workDir, staffDir], posted).catch(e => console.error(`[bot] staff channel: ${e.message}`));
  if (v) await tags.afterLook(thread, st, v, post).catch(e => console.error(`[tags] ${threadId}: ${e.message}`));
  save();
  fs.appendFileSync(VERDICTS, JSON.stringify({
    at: new Date().toISOString(), thread: threadId, title: st.title, why, outcome, dryRun: CFG.dryRun, post,
    verdict: v, turns: res.turns, cost: res.cost, usage: res.usage, tools: res.log,
  }) + '\n');
  for (const d of [workDir, staffDir]) fs.rmSync(d, { recursive: true, force: true });
}

/** the thread as the model reads it: text attachments saved to workDir (whatever their name: a chrome://gpu report
 *  comes as .txt.phps, a long paste as message.txt), images inlined; save backups and the pictures as they were posted
 *  to staffDir, for the staff report */
async function transcript(thread, msgs, workDir, staffDir, why, extra) {
  const applied = (thread.appliedTags ?? []).map(id => thread.parent.availableTags?.find(t => t.id === id)?.name).filter(Boolean);
  const topics = Tags.of(thread.parent).topics.map(t => t.name);
  const lines = [`Forum: #${thread.parent.name}`, `Title: ${thread.name}`, `Tags: ${applied.join(', ') || 'none'}`,
    ...(topics.length ? [`Tags you may add: ${topics.join(', ')}`] : []),
    `Why the bot looks now: ${WHY[why] ?? why}`, ...(extra?.text ? [extra.text] : []), ''];
  const images = [];
  let n = 0;
  const who = m => m.author.id === client.user.id ? 'this bot' : m.author.id === thread.ownerId ? 'the poster'
    : isStaff(m.member, thread) ? 'staff' : 'another member';
  const time = m => m.createdAt.toISOString().slice(0, 16).replace('T', ' ');
  for (const m of msgs) {
    const to = m.reference?.messageId && msgs.find(x => x.id === m.reference.messageId);
    const re = to ? `, in reply to ${to.member?.displayName ?? to.author.username} (${who(to)}) at ${time(to)}` : '';
    lines.push(`[${time(m)} UTC] ${m.member?.displayName ?? m.author.username} (${who(m)}${re}):`);
    if (m.content) lines.push(m.content);
    for (const a of m.attachments.values()) {
      const kb = `${Math.round(a.size / 1024)} KB`;
      const type = (a.contentType ?? '').split(';')[0];
      const name = `${++n}-${a.name.replace(/[^\w.-]+/g, '_')}`;
      if (IMAGE_TYPES.includes(type) && a.size <= MAX_IMAGE && images.length < MAX_IMAGES) {
        const data = await download(a.url), pic = data && await picture(data);
        if (pic) {
          images.push(pic);
          if (data.length <= MAX_UPLOAD) fs.writeFileSync(path.join(staffDir, name), data);
          lines.push(`  [picture ${images.length}: ${a.name}]`);
          continue;
        }
      }
      if (SAVES_ZIP.test(a.name) && a.size <= MAX_UPLOAD) {
        const data = await download(a.url);
        if (data) { fs.writeFileSync(path.join(staffDir, name), data); lines.push(`  [saves backup: ${a.name}, ${kb} (a zip, not readable here)]`); continue; }
      }
      if (!/^(image|video|audio)\//.test(type) && !/\.(zip|7z|rar|mp4|mov|webm)$/i.test(a.name) && a.size <= MAX_TEXT) {
        const data = await download(a.url);
        if (data && !data.subarray(0, 8192).includes(0)) {
          fs.writeFileSync(path.join(workDir, name), data);
          lines.push(`  [attachment: attachments/${name}, ${kb}]`);
          continue;
        }
      }
      lines.push(`  [attachment not opened: ${a.name}, ${type || 'unknown type'}, ${kb}]`);
    }
    lines.push('');
  }
  return { text: lines.join('\n'), images };
}

// ------------------------------------------------------------------------------------------- the staff channel --
// A report is a post in the staff channel (in a text channel: a message with a thread on it).  The post is an overview,
// rewritten at every change: the problem, where it stands (open, fixed, reported again), its forum and category, every
// thread about it, its files with links to download them, and a line with a Discord timestamp for each change.  Its
// thread holds the rest: first the part to copy to Claude, which takes in each update as it comes, with the first
// thread's files; then each update with its own files (a later thread about the problem, new logs or pictures in any
// of them, a fix that went live, the poster saying it works).  Only the thread's followers are notified.  The first
// thread has staffMsg, staffThread and report; the later ones reportOf and the same ids.

/** REPORT, on the first thread: { title, where ('bug-reports · audio'), guild, threads: [id], parts: [text] (the part
 *  for Claude: the report, then one for each update), prompt (the message that shows them), files: [{ name, size,
 *  msg, id, url }], log: [[seconds, line]], fix: { commit, at, added }, confirmed: { at, thread } (a poster says it
 *  works), again: { at, thread } (a new thread or log after the fix or the poster's word, until the next of these) } */

const linkOf = (guild, id) => `https://discord.com/channels/${guild}/${id}`;
const stamp = s => `<t:${Math.floor(s)}:R>`;
const seconds = () => Math.floor(Date.now() / 1000);
const bytes = n => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** the report's first message (in a forum channel: its post's starter) */
async function reportMessage(staff, root) {
  if (staff.type === ChannelType.GuildForum) {
    const th = await client.channels.fetch(root.staffThread).catch(() => null);
    return th?.fetchStarterMessage().catch(() => null) ?? null;
  }
  return staff.messages.fetch(root.staffMsg).catch(() => null);
}

/** the report's thread, opened on a report from before there were threads */
async function reportThread(staff, root) {
  if (root.staffThread) return client.channels.fetch(root.staffThread).catch(() => null);
  const m = await reportMessage(staff, root);
  const th = await m?.startThread({ name: (root.summary || root.title).slice(0, 100), autoArchiveDuration: 10080 }).catch(() => null);
  if (th) root.staffThread = th.id;
  return th;
}

/** where a report stands: open; fixed (a release's fix is live, and the bot told a thread) or solved (a poster says
 *  it works); or reported again (a new thread or log after that).  mark: what the post's name starts with */
function standing(r) {
  const fix = r.fix && `\`${r.fix.commit}\` live ${stamp(r.fix.at)}`;
  if (r.again) {
    return { mark: '🟠 ', line: `🟠 **Reported again** ${stamp(r.again.at)} in ${linkOf(r.guild, r.again.thread)}, ` +
      `after ${fix ? `the fix ${fix}` : 'a poster said it works'}` };
  }
  if (r.fix) {
    const sure = r.confirmed?.at >= r.fix.at ? `a poster confirmed it ${stamp(r.confirmed.at)}` : 'no player confirmed it yet';
    return { mark: '✅ ', line: `✅ **${r.fix.added ? 'Added' : 'Fixed'}**: ${fix}, ${sure}` };
  }
  if (r.confirmed) return { mark: '✅ ', line: `✅ **Solved**: the poster says it works in ${linkOf(r.guild, r.confirmed.thread)} ${stamp(r.confirmed.at)}` };
  return { mark: '', line: '🔴 **Open**' };
}

/** the last of `items` that fit in `room` characters, joined by `sep`, after left(n) for the n left out */
function newest(items, sep, room, left) {
  for (let n = 0; ; n++) {
    const text = (n ? [left(n), ...items.slice(n)] : items).join(sep);
    if (text.length <= room || n >= items.length) return text;
  }
}

/** the report's post: the problem, where it stands, its forum and category, its threads, its files with links to
 *  download them, and its changes, the newest when they are too many for a message */
function overview(r, forum) {
  const { mark, line } = standing(r);
  // a post's name is its title (100 characters at most); a message in a text channel has none
  const title = !forum ? [`## ${r.title}`] : (mark + r.title).length > 100 ? [`**${r.title}**`] : [];
  const threadLinks = newest(r.threads.map(id => linkOf(r.guild, id)), ' · ', 600, n => `${n} more`);
  const head = [...title, line, r.where, `**Threads:** ${threadLinks}`].join('\n');
  const files = r.files.map(f => `- [${f.name.replace(/[[\]]/g, '_')}](<${f.url}>) ${bytes(f.size)}`);
  const log = r.log.map(([at, text]) => `${stamp(at)} ${text}`);
  const room = 2000 - head.length - 30;          // 30: the two headings
  const shown = newest(files, '\n', Math.min(files.join('\n').length, room - Math.min(log.join('\n').length, 600)),
    n => `- ${n} earlier in the thread`);
  const [first, ...later] = log;                 // the first change (when it was reported) stays
  const changes = [first, ...later.length ? [newest(later, '\n', room - shown.length - first.length - 1, n => `${n} more in the thread`)] : []];
  return [head, ...(files.length ? ['**Files:**', shown] : []), '**Updates:**', ...changes].join('\n');
}

/** one part for Claude: its lines, and the names of the files that came with it */
const part = (lines, files) => [...lines, files.length && `Attached: ${files.map(f => f.name).join(', ')}`].filter(Boolean).join('\n').trim();

/** text in a code block, at most `max` characters: a selection or Copy Text takes it without Discord's markup */
function fence(text, max) {
  text = text.replace(/```/g, "'''");
  const room = Math.max(0, max - 12);
  return '```text\n' + (text.length > room ? `${text.slice(0, room - 2)} …` : text) + '\n```';
}

/** the report's part for Claude: the report and each update after it, in one code block; when they are too long for
 *  a message, the longest are cut the most (each update's message has its whole text) */
function promptText(r) {
  const parts = r.parts.map(p => p.replace(/```/g, "'''")), cut = [];
  let room = 2000 - 12 - 2 * (parts.length - 1);   // the code block, a blank line between the parts
  [...parts.keys()].sort((a, b) => parts[a].length - parts[b].length).forEach((i, k, order) => {
    const share = Math.floor(room / (order.length - k));
    cut[i] = parts[i].length > share ? `${parts[i].slice(0, Math.max(0, share - 2))} …` : parts[i];
    room -= cut[i].length;
  });
  return '```text\n' + cut.join('\n\n') + '\n```';
}

/** an update in the report's thread: its text with its files (the files past a message's share in the next
 *  messages); their links go into the report.  -> the first message's id */
async function postUpdate(target, r, content, files) {
  const groups = [[]];
  for (const f of files) {
    const g = groups.at(-1);
    if (g.length && (g.length === MESSAGE_FILES || g.reduce((s, x) => s + x.size, f.size) > MESSAGE_BYTES)) groups.push([f]);
    else g.push(f);
  }
  let first = null;
  for (const [i, g] of groups.entries()) {
    const names = g.map(f => f.name).join(', ');
    let failed = null;
    let m = await target.send({ ...(i ? {} : { content }), files: g.map(f => ({ attachment: f.attachment, name: f.name })),
      allowedMentions: { parse: [] } }).catch(e => { failed = e; return null; });
    if (!m) {                                    // too big after all: the text, and which files are missing
      console.error(`[staff] could not send ${names || 'an update'}: ${failed.message}`);
      if (!g.length) throw failed;
      if (!i) m = await target.send({ content, allowedMentions: { parse: [] } });
      await target.send({ content: `Could not copy ${names} here: ${failed.message}`.slice(0, 2000), allowedMentions: { parse: [] } });
    }
    first ??= m?.id;
    for (const a of m?.attachments.values() ?? []) r.files.push({ name: a.name, size: a.size, msg: m.id, id: a.id, url: a.url });
  }
  return first;
}

/** the files' download links as Discord gives them now: it signs a link for about a day */
async function freshLinks(target, r) {
  for (const id of new Set(r.files.map(f => f.msg))) {
    const m = await target.messages.fetch(id).catch(() => null);
    for (const a of m?.attachments.values() ?? []) { const f = r.files.find(f => f.id === a.id); if (f) f.url = a.url; }
  }
}

/** the report's post, and its part for Claude when `prompt`, from the report; the post's name shows where it stands */
async function render(staff, root, th, prompt = true) {
  const r = root.report, forum = staff.type === ChannelType.GuildForum, target = th ?? (forum ? null : staff);
  if (target) await freshLinks(target, r);
  await (forum ? th?.messages : staff.messages)?.edit(forum ? root.staffThread : root.staffMsg,
    { content: overview(r, forum), allowedMentions: { parse: [] } });
  if (prompt && r.prompt && target) {
    await target.messages.edit(r.prompt, { content: promptText(r), allowedMentions: { parse: [] } })
      .catch(e => console.error(`[staff] the part for Claude: ${e.message}`));
  }
  // not waited for: Discord renames a thread twice in 10 minutes, and makes the third wait
  const name = (standing(r).mark + r.title).slice(0, 100);
  if (th && th.name !== name) th.setName(name).catch(e => console.error(`[staff] the report's name: ${e.message}`));
}

/** a report from before the overview: its text and files move into its thread as the part for Claude, and the post
 *  becomes the overview */
async function upgrade(staff, rootId, root) {
  if (root.report) return root.report;
  const m = await reportMessage(staff, root), th = await reportThread(staff, root);
  const target = th ?? (staff.isTextBased() ? staff : null), text = m?.content ?? '';
  const old = text.match(/```text\n([\s\S]*?)\n```/)?.[1] ?? text.replace(/^-# .*\n?/gm, '').trim();
  const r = root.report = {
    title: (root.summary || root.title).slice(0, 300), where: [root.forum, root.category].filter(Boolean).join(' · '),
    guild: root.guild, threads: [rootId, ...Object.keys(threads).filter(id => threads[id].reportOf === rootId)],
    parts: old ? [old] : [], files: [],
    log: m ? [[Math.floor(m.createdTimestamp / 1000), `Reported from ${linkOf(root.guild, rootId)}`]] : [],
  };
  if (m && target) {
    const files = [];
    for (const a of m.attachments.values()) {
      const data = await download(a.url);
      if (data) files.push({ attachment: data, name: a.name, size: data.length });
    }
    r.prompt = await postUpdate(target, r, promptText(r), files);
    if (files.length && files.length === m.attachments.size) await m.edit({ attachments: [] }).catch(() => {});
  }
  console.log(`[staff] the report on ${rootId} got its overview`);
  return r;
}

const reportQueues = new Map();                  // report (its first thread's id) -> its last change
/** fn after the report's changes before it: one change of a report at a time */
function inOrder(rootId, fn) {
  const p = (reportQueues.get(rootId) ?? Promise.resolve()).then(fn);
  reportQueues.set(rootId, p.catch(() => {}));
  return p;
}

/** a change to a report: its update (text and files) in the report's thread, its part for Claude, a line in the post.
 *  u: { line, content, part, files, thread (one more thread about it), fix, confirmed and again (a thread's id) } */
function reportUpdate(staff, rootId, u) {
  return inOrder(rootId, async () => {
    const root = threads[rootId];
    if (!root?.staffMsg) return;
    const r = await upgrade(staff, rootId, root), th = await reportThread(staff, root);
    const at = seconds(), target = th ?? (staff.isTextBased() ? staff : null);
    if (u.thread && !r.threads.includes(u.thread)) r.threads.push(u.thread);
    if (u.fix || u.confirmed) delete r.again;
    if (u.fix) r.fix = u.fix;
    if (u.confirmed) r.confirmed = { at, thread: u.confirmed };
    if (u.again && (r.fix || r.confirmed)) r.again = { at, thread: u.again };
    if (u.content && target) await postUpdate(target, r, u.content, u.files ?? []);
    if (u.part) r.parts.push(u.part);
    r.log.push([at, u.line]);
    await render(staff, root, th, !!u.part);
    save();
  });
}

/** files of this look for the staff: logs and other text, pictures and save backups, at most MAX_UPLOADS */
const staffFiles = dirs => dirs.flatMap(d => fs.readdirSync(d).sort((a, b) => parseInt(a) - parseInt(b)).map(f => path.join(d, f)))
  .map(f => ({ attachment: f, name: path.basename(f).replace(/^\d+-/, ''), size: fs.statSync(f).size }))
  .filter(f => f.size <= MAX_UPLOAD).slice(0, MAX_UPLOADS);

/** a look's verdict for the staff: a new report, an update in the report about the same problem, or nothing */
async function tellStaff(thread, st, v, post, dirs, posted) {
  const link = linkOf(thread.guildId, thread.id);
  const dup = v.duplicate_of && v.duplicate_of !== thread.id && threads[v.duplicate_of] ? v.duplicate_of : null;
  const rootId = dup ? (threads[dup].reportOf ?? dup) : null;
  const root = rootId ? threads[rootId] : null;
  const reported = root?.staffMsg ? root : null;     // the problem already has a report
  if (!v.escalate && !reported && !(post && !posted)) return;
  const staff = await client.channels.fetch(CFG.staffChannel);
  if (!staff?.isTextBased() && staff?.type !== ChannelType.GuildForum) throw new Error(`${CFG.staffChannel} is not a channel the bot can post in`);
  const did = !post ? 'did not reply' : v.action === 'ask' ? 'asked the poster for more' : 'answered the poster';
  const dry = post && !posted ? `Dry run, not posted. The reply:\n${quote(post.slice(0, 600))}` : '';
  const files = staffFiles(dirs);
  const where = `"${st.title}" in #${st.forum}${v.category ? ` (${v.category})` : ''}`;

  if (reported && !st.staffMsg) {                 // the same problem again: an update in its report
    Object.assign(st, { staffMsg: reported.staffMsg, staffThread: reported.staffThread, reportOf: rootId });
    const text = part([`Also reported: ${where}`, `Thread: ${link}`, v.notes.trim()], files), head = `**Also reported** in ${link}`;
    await reportUpdate(staff, rootId, {
      line: `Also reported in ${link}; the bot ${did}`, part: text, files, thread: thread.id, again: thread.id,
      content: [head, fence(text, 2000 - head.length - dry.length - 2), dry].filter(Boolean).join('\n'),
    });
    console.log(`[staff] ${thread.id} added to the report on ${rootId}`);
    return;
  }
  if (!v.escalate || st.staffMsg) {              // nothing new for the developer; in a dry run, the reply for review
    if (dry) await general.toStaff(`Dry run: ${st.title}`, `${link} · ${v.summary}\n${dry}`);
    return;
  }
  // a new report; an earlier thread about the problem that nobody reported joins it
  const earlier = root && !root.staffMsg ? rootId : null;
  const r = {
    title: (v.summary || st.title).slice(0, 300), where: [st.forum, v.category].filter(Boolean).join(' · '),
    guild: thread.guildId, threads: [...(earlier ? [earlier] : []), thread.id], files: [],
    parts: [part([`Forum report: ${where}`, `Thread: ${link}`,
      earlier && `Earlier thread about it: "${root.title}": ${linkOf(thread.guildId, earlier)}`, v.notes.trim()], files)],
    log: [[seconds(), `Reported from ${link}${earlier ? ` and ${linkOf(thread.guildId, earlier)}` : ''}; the bot ${did}`]],
  };
  const forum = staff.type === ChannelType.GuildForum, name = r.title.slice(0, 100);
  const first = { content: overview(r, forum), allowedMentions: { parse: [] } };
  let m, th;
  if (forum) {
    th = await staff.threads.create({ name, message: first });
    m = { id: th.id };
  } else {
    m = await staff.send(first);
    th = await m.startThread({ name, autoArchiveDuration: 10080 }).catch(e => { console.error(`[bot] report thread: ${e.message}`); return null; });
  }
  Object.assign(st, { staffMsg: m.id, staffThread: th?.id, report: r });
  if (earlier) Object.assign(root, { staffMsg: m.id, staffThread: th?.id, reportOf: thread.id });
  await inOrder(thread.id, async () => {          // the part for Claude with the files, then the post with their links
    const target = th ?? staff;
    r.prompt = await postUpdate(target, r, promptText(r), files);
    if (dry) await target.send({ content: dry.slice(0, 2000), allowedMentions: { parse: [] } });
    await render(staff, st, th, false);
  });
  console.log(`[staff] ${thread.id} reported to the staff${th ? ', with a thread for updates' : ' (no thread: no right to open one?)'}`);
  if (earlier) {
    const rt = await client.channels.fetch(earlier).catch(() => null);
    if (rt) await tags.add(rt, 'aware').catch(e => console.error(`[tags] ${earlier}: ${e.message}`));
  }
}

/** a new log or picture in a thread that has a report: an update in the report, with the files */
async function relay(m, st) {
  const staff = await client.channels.fetch(CFG.staffChannel).catch(() => null);
  if (!staff) return;
  const files = [];
  for (const a of m.attachments.values()) {
    if (a.size > MAX_UPLOAD || files.length >= MAX_UPLOADS) continue;
    const data = await download(a.url);
    if (data) files.push({ attachment: data, name: a.name, size: data.length });
  }
  const all = [...m.attachments.values()], log = hasLog(m);
  const kind = (log ? 'log' : all.every(a => /^image\//.test(a.contentType ?? '')) ? 'picture' : 'file') + (all.length > 1 ? 's' : '');
  const who = m.author.id === m.channel.ownerId ? 'the poster' : 'a member';
  const link = linkOf(m.guildId, m.channelId), head = `**New ${kind}** from ${who} in ${link}`;
  const text = part([`New in "${m.channel.name}" from ${who}: ${link}`, m.content.trim().slice(0, 1200)], files);
  // a log after the fix: it may still happen
  await reportUpdate(staff, st.reportOf ?? m.channelId, { line: `New ${kind} from ${who} in ${link}`, part: text, files,
    again: log ? m.channelId : null, content: `${head}\n${fence(text, 2000 - head.length - 1)}` });
  console.log(`[staff] ${m.channelId}: ${files.length} file(s) from ${who} passed on to its report`);
}

/** the poster of a thread that has a report says it works now (tags.mjs): the report says so */
function solved(thread) {
  const st = threads[thread.id];
  if (!st?.staffMsg || !CFG.staffChannel) return;
  const rootId = st.reportOf ?? thread.id, link = linkOf(thread.guildId, thread.id);
  const what = `**${threads[rootId]?.report?.fix ? 'Confirmed' : 'Solved'}**: the poster says it works now in ${link}`;
  client.channels.fetch(CFG.staffChannel)
    .then(staff => reportUpdate(staff, rootId, { line: what, content: what, part: `The poster says it works now: ${link}`, confirmed: thread.id }))
    .catch(e => console.error(`[staff] ${thread.id}: ${e.message}`));
}

const quote = s => s.split('\n').map(l => `> ${l}`).join('\n');

const WHY = {
  'new post': 'a new post',
  'follow-up': 'the poster wrote again after the bot asked for information',
  'reply': 'someone replied to the bot or mentioned it (see "When someone replies to the bot")',
  'asked by staff': 'staff mentioned the bot and want its reply: answer or ask, never none; with no fix and nothing to ask, answer with a short account of what you found (what the log shows, whether it is known or fixed)',
  'fix live': 'a release just went live, and a commit in it may fix this thread\'s problem (see "When a fix goes live")',
  'implemented': 'a release just went live, and a commit in it may add what this suggestion asks for (see "When a suggestion is carried out")',
  'bump': 'the poster wrote again after the thread was quiet for half a day or more: they are waiting for an answer (see "When the poster bumps")',
  'log': 'someone posted a log (or another text file) in the thread (see "When a log is posted")',
};

/** the poster's newest bump in these messages (oldest first) that neither staff nor the bot answered since, or null.
 *  A bump: the poster writes after nobody wrote for BUMP_QUIET_MS ("any ideas?", or new details after a long wait) */
function openBump(msgs, ownerId) {
  let bump = null;
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.author.id === client.user.id || (m.author.id !== ownerId && isStaff(m.member, m.channel))) bump = null;
    else if (m.author.id === ownerId && m.createdTimestamp - msgs[i - 1].createdTimestamp >= BUMP_QUIET_MS) bump = m;
  }
  return bump;
}

// ---------------------------------------------------------------------------------------------- a release --
/** a new live version: the threads its commits may fix get a 'fix live' look; at most FIX_MAX of them */
async function checkRelease() {
  const rev = await repo.liveRev();
  if (!rev) return;
  let last = null;
  try { last = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')).rev; } catch { /* first start */ }
  if (last === rev) return;
  // the new version is kept once this release is dealt with, so a check that fails is tried again next time
  const seen = () => fs.writeFileSync(LIVE_FILE, JSON.stringify({ rev, at: new Date().toISOString() }));
  if (!last) { seen(); return console.log(`[release] live is ${rev}`); }
  await repo.sync(true);
  if (!(await repo.has(last)) || !(await repo.has(rev))) { seen(); return console.log(`[release] live ${last} -> ${rev}: not both in the code copy, skipped`); }
  const commits = (await repo.git(['log', '--no-merges', '-n', '60', '--format=commit %h %s%n%b', `${last}..${rev}`])).trim();
  if (!commits) { seen(); return console.log(`[release] live ${last} -> ${rev}: no new commits (a rollback?)`); }
  const since = new Date(Date.now() - FIX_DAYS * 86400_000).toISOString();
  const open = t => !t.fixed && t.fixChecked !== rev;
  const reports = Object.entries(threads)
    .filter(([, t]) => t.created >= since && open(t) && !isSuggestion(t) && t.category !== 'question')
    .sort(byActivity).slice(0, 200);
  // a thread the bot never looked at (staff answered before its look) is only a title: its first post too
  for (const [id, t] of reports.filter(([, t]) => !t.summary && !t.snippet)) {   // one at a time: the rate limits
    const thread = await client.channels.fetch(id).catch(() => null);
    const m = await thread?.fetchStarterMessage().catch(() => null);
    if (m) t.snippet = m.content.replace(/\s+/g, ' ').slice(0, 200);
  }
  save();
  const candidates = reports
    .map(([id, t]) => ({ id, line: `${id} | #${t.forum} | ${t.created.slice(0, 10)} | ${t.category ?? '?'} | ${t.title} | ${t.summary || t.snippet || ''}` }));
  await indexSuggestions().catch(e => console.error(`[release] reading the suggestions: ${e.message}`));
  const wishes = Object.entries(threads).filter(([, t]) => isSuggestion(t) && open(t) && !t.decided)
    .sort(byActivity).slice(0, 400)
    .map(([id, t]) => ({ id, line: `${id} | #${t.forum} | ${t.created.slice(0, 10)} | ${t.title} | ${t.summary || t.snippet || ''}` }));
  const n = commits.split('\ncommit ').length;
  console.log(`[release] live ${last} -> ${rev}: ${n} commit(s), checking ${candidates.length} thread(s) and ${wishes.length} suggestion(s)`);
  const o = { client: anthropic, model: CFG.model, effort: CFG.effort, commits: commits.slice(0, 60_000) };
  const [fixes, features] = await Promise.all([matchFixes({ ...o, candidates }), matchFeatures({ ...o, candidates: wishes })]);
  if (fixes.error || features.error) return console.log(`[release] matching failed, again at the next check: ${fixes.error || features.error}`);
  seen();
  const list = ms => ms.length ? `: ${ms.map(m => `${m.thread} (${m.commit})`).join(', ')}` : '';
  console.log(`[release] ${fixes.matches.length} thread(s) may be fixed${list(fixes.matches)}; ` +
    `${features.matches.length} suggestion(s) may be carried out${list(features.matches)}`);
  for (const [ms, max, why, what] of [[fixes.matches, FIX_MAX, 'fix live', "this thread's problem"],
    [features.matches, FEATURE_MAX, 'implemented', 'what this suggestion asks for']]) {
    for (const m of ms.slice(0, max)) {
      const body = (await repo.git(['show', '--no-patch', '--format=%h %s%n%n%b', m.commit]).catch(() => '')).trim().slice(0, 1500);
      console.log(`[release] ${m.thread}: ${m.why}`);
      enqueue(m.thread, why, { rev, commit: m.commit, subject: body.split('\n')[0].replace(/^\S+\s*/, ''),
        text: `The commit that went live:\n${body || m.commit}\nWhy it may be ${what}: ${m.why}` });
    }
  }
}

/** the suggestion forums' threads, the archived ones too (the newest SUGGESTION_INDEX of each), into `threads` with
 *  their first posts and whether they are decided (Complete, Denied, locked): what a release may carry out */
async function indexSuggestions() {
  const forums = client.channels.cache.filter(ch => isForum(ch) && SUGGESTIONS.test(ch.name) && (!CFG.forums.length || CFG.forums.includes(ch.id)));
  let fresh = 0;
  for (const forum of forums.values()) {
    const found = [...(await forum.threads.fetchActive()).threads.values()];
    for (let before, more = true; more && found.length < SUGGESTION_INDEX;) {
      const page = await forum.threads.fetchArchived({ type: 'public', before, limit: 100 });
      found.push(...page.threads.values());
      before = page.threads.last();
      more = page.hasMore && !!before;
    }
    for (const t of found) {
      if (!threads[t.id]) fresh++;
      const st = threads[t.id] ??= { title: t.name, forum: forum.name, guild: forum.guildId, created: t.createdAt.toISOString(), status: 'seen', replies: 0 };
      Object.assign(st, { title: t.name, decided: t.locked || Tags.decided(t) });
      if (st.snippet || st.summary) continue;
      const m = await t.fetchStarterMessage().catch(() => null);   // one at a time: discord.js waits out the rate limits
      if (m) st.snippet = m.content.replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  save();
  if (fresh) console.log(`[release] ${fresh} suggestion thread(s) read for the first time`);
}

async function download(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch { return null; }
}

/** one known thread as the model sees it */
function threadLine([id, t]) {
  const what = t.summary || (t.snippet ? `first post: ${t.snippet}` : '');
  return `- ${id} https://discord.com/channels/${t.guild}/${id} #${t.forum}, ${(t.active ?? t.created).slice(0, 10)} ` +
    `[${[t.category, t.status, t.staffMsg && 'developer told'].filter(Boolean).join(', ')}] ${t.title}${what ? `: ${what}` : ''}`;
}
const byActivity = (a, b) => (b[1].active ?? b[1].created).localeCompare(a[1].active ?? a[1].created);
/** the threads active last, for the context */
function recentThreads(except) {
  return Object.entries(threads).filter(([id]) => id !== except).sort(byActivity).slice(0, 30).map(threadLine).join('\n');
}
/** every known thread, for the search_threads tool: [{ line, text }] */
function threadIndex(except) {
  return Object.entries(threads).filter(([id]) => id !== except).sort(byActivity)
    .map(e => ({ line: threadLine(e), text: `${e[1].title}\n${e[1].summary ?? ''}\n${e[1].snippet ?? ''}` }));
}

/** the forums' threads with posts in the last STARTUP_MS (titles, first posts), so the bot can point to them; the
 *  ones opened in that time that it never looked at get their look now, so a restart misses no post.  Nothing older */
async function indexForums() {
  const since = Date.now() - STARTUP_MS;
  const snowflakeTime = id => Number((BigInt(id) >> 22n) + 1420070400000n);
  const found = [], recent = [];
  for (const guild of client.guilds.cache.values()) {
    const active = await guild.channels.fetchActiveThreads().catch(() => null);
    // a known thread that is not active was archived (or deleted) while the bot was away
    if (active) for (const [id, st] of Object.entries(threads)) if (st.guild === guild.id) st.closed = !!(active.threads.get(id)?.locked ?? true);
    for (const t of active?.threads.values() ?? []) {
      if (!watched(t) || Math.max(t.createdTimestamp, t.lastMessageId ? snowflakeTime(t.lastMessageId) : 0) < since) continue;
      const fresh = !threads[t.id] && t.createdTimestamp >= since;
      const st = threads[t.id] ??= { title: t.name, forum: t.parent.name, guild: guild.id, created: t.createdAt.toISOString(),
        status: fresh ? 'new' : 'seen', replies: 0 };
      st.title = t.name;
      if (fresh) schedule(t.id, 'new post');
      else if (st.status !== 'new') recent.push(t);
      if (!st.snippet && !st.summary) found.push(t);
    }
  }
  save();
  console.log(`[bot] forums: ${found.length} threads with posts in the last ${STARTUP_MS / 3600_000} h read, ` +
    `${Object.values(threads).filter(t => t.status === 'new').length} waiting for a look`);
  for (const t of found) {                         // one at a time: discord.js waits out the rate limits
    const m = await t.fetchStarterMessage().catch(() => null);
    if (m) threads[t.id].snippet = m.content.replace(/\s+/g, ' ').slice(0, 200);
  }
  save();
  // bumps while the bot was away
  for (const t of recent) {
    const msgs = await t.messages.fetch({ limit: 25 }).catch(() => null);
    const bump = msgs && openBump([...msgs.values()].reverse().filter(m => !m.system), t.ownerId);
    if (bump && bump.createdTimestamp >= since && threads[t.id].bump !== bump.id) schedule(t.id, 'bump');
  }
}

// ------------------------------------------------------------------------------------------------- events --
client.on(Events.ClientReady, c => {
  console.log(`[bot] ${c.user.tag} on ${c.guilds.cache.size} server(s); ${CFG.dryRun ? 'dry run (replies go to the staff channel only), ' : ''}` +
    `${CFG.forums.length ? `forums ${CFG.forums.join(', ')}` : 'every forum'}, ` +
    `${CFG.staffChannel ? `staff channel ${CFG.staffChannel}` : 'no staff channel'}, model ${CFG.model} (${CFG.effort}), ` +
    `$${spend.month.toFixed(2)} of $${CFG.budget} spent this month, $${spend.today.toFixed(2)} of $${spend.share().toFixed(2)} today`);
  repo.sync(true).catch(e => console.error(`[repo] ${e.message}`));
  c.application.commands.set([TRANSLATE]).catch(e => console.error(`[translate] the command: ${e.message}`));
  let checking = null;                           // one check at a time: the first one reads every suggestion
  const release = () => checking ??= checkRelease().catch(e => console.error(`[release] ${e.message}`)).finally(() => { checking = null; });
  indexForums().catch(e => console.error(`[bot] forum index: ${e.message}`)).finally(release);
  setInterval(release, RELEASE_CHECK_MS);
  setInterval(() => general.tick().catch(e => console.error(`[general] ${e.message}`)), 60_000);
  // posts that came in shortly before a restart still get their look
  for (const [id, t] of Object.entries(threads)) if (t.status === 'new' && Date.now() - Date.parse(t.created) < STARTUP_MS) schedule(id, 'new post');
  lookLater();
});

/** an event handler that logs what goes wrong instead of taking the bot down */
const guard = (name, fn) => (...a) => { try { fn(...a); } catch (e) { console.error(`[bot] ${name}: ${e.stack || e}`); } };

client.on(Events.ThreadCreate, guard('new thread', (thread, created) => {
  if (!created || !watched(thread) || threads[thread.id]) return;
  const now = new Date().toISOString();
  threads[thread.id] = { title: thread.name, forum: thread.parent.name, guild: thread.guildId, created: now, active: now, status: 'new', replies: 0 };
  save();
  schedule(thread.id, 'new post');
}));

client.on(Events.ThreadUpdate, guard('thread update', (old, thread) => {
  const st = threads[thread.id];
  const closed = !!(thread.archived || thread.locked);
  if (st && !!st.closed !== closed) { st.closed = closed; save(); }
}));
client.on(Events.ThreadDelete, guard('thread deleted', thread => {
  if (threads[thread.id] && !threads[thread.id].closed) { threads[thread.id].closed = true; save(); }
}));

client.on(Events.MessageCreate, guard('message', m => {
  if (m.system) return;                          // "changed the post title", pins, joins
  try { general.onMessage(m); } catch (e) { console.error(`[general] message: ${e.stack || e}`); }
  if (archive && m.guild) {
    archive.add({
      id: m.id, at: m.createdAt.toISOString(),
      channel: m.channel.isThread() ? m.channel.parent?.name : m.channel.name, thread: m.channel.isThread() ? m.channel.name : '',
      author: m.member?.displayName ?? m.author.username, text: m.content.slice(0, 4000), files: [...m.attachments.values()].map(a => a.name),
    });
  }
  const thread = m.channel;
  if (m.author.bot || !watched(thread)) return;
  // a thread from before the forum index (no posts in the hours it reads at start): known from now on.  A new one
  // waits for its ThreadCreate, which gives it its first look
  if (!threads[thread.id] && Date.now() - thread.createdTimestamp > 10 * 60_000) {
    threads[thread.id] = { title: thread.name, forum: thread.parent.name, guild: thread.guildId, created: thread.createdAt.toISOString(),
      status: 'seen', replies: 0 };
  }
  const st = threads[thread.id];
  if (!st) return;
  st.active = m.createdAt.toISOString();
  tags.onMessage(m);                             // the poster saying it works now: Solved
  if (st.staffMsg && CFG.staffChannel && m.attachments.size && !isStaff(m.member, thread)) {
    relay(m, st).catch(e => console.error(`[bot] relay to the report: ${e.message}`));
  }
  // staff ask by a mention by name; anyone else talks to the bot by a mention or a reply to its message
  const named = m.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
  if (isStaff(m.member, thread)) {
    if (named) { schedule(thread.id, 'asked by staff'); return; }
    if (st.status !== 'staff') console.log(`[bot] ${thread.id} "${st.title}": staff wrote, the bot stays out`);
    st.status = 'staff'; save();
    const t = timers.get(thread.id); if (t) { clearTimeout(t.timer); timers.delete(thread.id); }
    return;
  }
  const op = m.author.id === thread.ownerId;
  if (st.status === 'new') { if (op) schedule(thread.id, 'new post'); return; }
  if (op && st.status === 'asked') { schedule(thread.id, 'follow-up'); return; }
  // a log, from the poster or anyone else: always a look, also past the reply cap and where staff wrote
  if (hasLog(m)) { schedule(thread.id, 'log'); return; }
  // someone talking to the bot: an answer, up to BOT_MAX_TALK replies in the thread, also where staff wrote
  if (!op) { if (toBot(m)) schedule(thread.id, 'reply'); return; }
  // the poster after a quiet half day: a bump, also in a thread staff wrote in before and left
  thread.messages.fetch({ before: m.id, limit: 1 }).then(before => {
    const prev = before.first();
    if (prev && m.createdTimestamp - prev.createdTimestamp >= BUMP_QUIET_MS) schedule(thread.id, 'bump');
    else if (toBot(m)) schedule(thread.id, 'reply');
  }).catch(e => console.error(`[bot] ${thread.id}: ${e.message}`));
}));
client.on(Events.InteractionCreate, i => {
  if (i.isMessageContextMenuCommand() && i.commandName === TRANSLATE.name) {
    translator.handle(i).catch(e => console.error(`[translate] ${i.targetId}: ${e.stack || e}`));
  }
});
client.on(Events.Error, e => console.error(`[bot] discord: ${e.message}`));
process.on('unhandledRejection', e => console.error(`[bot] ${e?.stack || e}`));

client.login(CFG.token).catch(e => { console.error(`[bot] login: ${e.message}`); process.exit(1); });
