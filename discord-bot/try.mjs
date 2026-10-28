// One look at a made-up forum post, without Discord: what the bot would post, and why.
//   node --env-file=.env try.mjs [--title T] [--forum F] [--tags "Crash,Bug"] "the post's text" [attachment ...]
// Text attachments are read as the bot reads a thread's; images (.png .jpg .gif .webp) go in as pictures.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive } from './archive.mjs';
import { blocks, investigate, newClient, picture, vet } from './investigate.mjs';
import { Repo, defaultSource } from './repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args.splice(i, 2)[1]; };
const title = opt('--title', 'Bug');
const forum = opt('--forum', 'bug-reports');
const topics = opt('--tags', '');                // the forum's tags a look may add (bot.mjs: Tags.of(forum).topics)
const [text, ...files] = args;
if (!text) { console.error('usage: try.mjs [--title T] [--forum F] [--tags "A,B"] "post text" [attachment ...]'); process.exit(2); }

const env = process.env;
const state = path.resolve(HERE, env.BOT_STATE || 'state');
const repo = new Repo({
  source: env.BOT_REPO || defaultSource(HERE),
  branch: env.BOT_BRANCH || 'main', dir: path.join(state, 'repo'),
  liveUrl: env.BOT_LIVE_URL || 'https://nfsu2.xyz/game.json', liveFile: env.BOT_LIVE_FILE || '/live/nfsu2.json',
});
const archiveDir = path.join(state, 'archive');
const archive = fs.existsSync(archiveDir) ? new Archive(archiveDir) : null;
fs.mkdirSync(state, { recursive: true });
const workDir = fs.mkdtempSync(path.join(state, 'try-'));

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const lines = [`Forum: #${forum}`, `Title: ${title}`, 'Tags: none',
  ...(topics ? [`Tags you may add: ${topics.split(',').map(t => t.trim()).join(', ')}`] : []), 'Why the bot looks now: a new post', '',
  `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC] player (the poster):`, text];
const images = [];
for (const [i, f] of files.entries()) {
  const data = TYPES[path.extname(f).toLowerCase()] && fs.readFileSync(f), pic = data && await picture(data);
  if (pic) {
    images.push(pic); lines.push(`  [picture ${images.length}: ${path.basename(f)}]`);
    console.log(`  picture ${path.basename(f)}: ${pic.tokens ?? '?'} tokens`);
    continue;
  }
  const name = `${i + 1}-${path.basename(f).replace(/[^\w.-]+/g, '_')}`;
  fs.copyFileSync(f, path.join(workDir, name));
  lines.push(`  [attachment: attachments/${name}, ${Math.round(fs.statSync(f).size / 1024)} KB]`);
}

try {
  const res = await investigate({
    client: newClient(), model: env.BOT_MODEL || 'claude-sonnet-5-5', effort: env.BOT_EFFORT || 'medium',
    repo, archive, workDir, thread: lines.join('\n'), images, step: s => console.log(`  ${s}`),
  });
  console.log(JSON.stringify(res.verdict, null, 2));
  const { post, why } = vet(res.verdict, { minConfidence: env.BOT_MIN_CONFIDENCE || 'medium' });
  console.log(`\n${post ? `--- would post (${why}) ---\n${blocks(post).join('\n--- next message ---\n')}\n---` : `--- would post nothing (${why}) ---`}`);
  console.log(`${res.turns} turns${res.cost != null ? `, $${res.cost.toFixed(3)}` : ''}, tokens ${JSON.stringify(res.usage)}`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
