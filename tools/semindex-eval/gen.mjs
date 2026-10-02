// Generates synthetic daily scraps in the app's format, plus the ground truth (which entries hold which fact).
//
//   node gen.mjs <outDir> [days=300] [lang=ja]
//
// lang: ja    Japanese notes, Japanese questions (the corpus the numbers in docs/design/semantic-search-2026-10.md come from)
//       en    English notes (topics_en.mjs), English questions
//       mixed both: each gold sentence is written in Japanese or in English at random, so are the filler, the journal paragraphs and
//             the logs; asked with Japanese questions, English questions and questions that mix the two, the right notes being the
//             same facts in either language (this is what tells whether a question in one language finds a note in the other)
//
// The random numbers are seeded, so the same notes come out every time. The Japanese output does not depend on the English files:
// the mixed corpus draws its language choices from a second generator, and the first one is used in the same order as before.
import fs from 'node:fs';
import path from 'node:path';
import { TOPICS, DISTRACTORS, FILLER, HOSTS } from './topics.mjs';
import { TOPICS_EN, DISTRACTORS_EN, FILLER_EN, MIXED_QUERIES } from './topics_en.mjs';

const OUT = process.argv[2];
const DAYS = Number(process.argv[3] || 300);
const LANG = process.argv[4] || 'ja';
if (!OUT || !['ja', 'en', 'mixed'].includes(LANG)) { console.error('usage: node gen.mjs <outDir> [days] [ja|en|mixed]'); process.exit(2); }

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(20261002);
const R2 = rng(77); // the language of each piece in the mixed corpus; never touched in the others
const pick = (a) => a[Math.floor(R() * a.length)];
const pad = (n) => String(n).padStart(2, '0');

const pickLang = () => (LANG === 'mixed' ? (R2() < 0.5 ? 'ja' : 'en') : LANG);
const BANK = { ja: { filler: FILLER, distractors: DISTRACTORS, topics: TOPICS }, en: { filler: FILLER_EN, distractors: DISTRACTORS_EN, topics: TOPICS_EN } };
const pickF = () => pick(BANK[pickLang()].filler);
const pickD = () => pick(BANK[pickLang()].distractors);
const JOIN = LANG === 'ja' ? '' : ' '; // Japanese sentences run together; English ones need their space

// where each gold sentence goes: a random day and a random kind of entry (short note, or inside a long journal entry)
const goldPlan = [];
TOPICS.forEach((t, ti) => t.gold.forEach((_, gi) => {
  const lang = pickLang();
  goldPlan.push({ topic: t.id, gi, lang, text: BANK[lang].topics[ti].gold[gi], day: Math.floor(R() * DAYS), long: R() < 0.45 });
}));
// ping logs of the three hosts on a few days (identifier queries)
const pingPlan = [];
HOSTS.forEach((h) => { for (let k = 0; k < 4; k++) pingPlan.push({ host: h, day: Math.floor(R() * DAYS) }); });

function pingLog(host, ts, lang) {
  const ms = 4 + Math.floor(R() * 9);
  const reply = () => [0, 1, 2, 3].map(() => lang === 'en'
    ? `Reply from ${host}: bytes=32 time=${ms + Math.floor(R() * 3)}ms TTL=251`
    : `${host} からの応答: バイト数 =32 時間 =${ms + Math.floor(R() * 3)}ms TTL=251`);
  if (lang === 'en') {
    return ['', `Pinging ${host} with 32 bytes of data:`, ...reply(), '', `Ping statistics for ${host}:`,
      '    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),', 'Approximate round trip times in milli-seconds:', `    Minimum = ${ms}ms, Maximum = ${ms + 2}ms, Average = ${ms + 1}ms`].join('\n');
  }
  return ['', `${host} に ping を送信しています 32 バイトのデータ:`,
    ...reply(), '',
    `${host} の ping 統計:`, '    パケット数: 送信 = 4、受信 = 4、損失 = 0 (0% の損失)、', 'ラウンド トリップの概算時間 (ミリ秒):', `    最小 = ${ms}ms、最大 = ${ms + 2}ms、平均 = ${ms + 1}ms`].join('\n');
}
function buildLog(ts) {
  const n = 5 + Math.floor(R() * 25);
  const lines = ['> go build ./...', ...Array.from({ length: n }, (_, i) => `ok  \tmd-memo/pkg/mod${i % 9}\t${(R() * 2).toFixed(3)}s`), 'PASS'];
  return lines.join('\n');
}

fs.mkdirSync(OUT, { recursive: true });
const truth = { lang: LANG, entries: {}, goldEntries: {}, entryLang: {}, queries: [] };
const start = new Date(2025, 8, 1);
let entryCount = 0;

for (let d = 0; d < DAYS; d++) {
  const date = new Date(start.getTime() + d * 86400000);
  const ds = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const file = `${ds}.md`;
  const entries = [];
  const n = 3 + Math.floor(R() * 7);
  let hh = 7;
  const gold = goldPlan.filter((g) => g.day === d);
  const pings = pingPlan.filter((p) => p.day === d);
  const slots = Math.max(n, gold.length + pings.length + 1);
  for (let e = 0; e < slots; e++) {
    hh = Math.min(23, hh + 1 + Math.floor(R() * 2));
    const mm = Math.floor(R() * 60);
    const hms = `${pad(hh)}:${pad(mm)}:${pad(Math.floor(R() * 60))}`;
    let text; let kind = 'note'; const goldHere = []; let entryLang = null;
    if (e < gold.length) {
      const g = gold[e];
      goldHere.push(g.text); entryLang = g.lang;
      if (g.long) {
        const paras = [];
        const m = 4 + Math.floor(R() * 3);
        const at = Math.floor(R() * m);
        for (let i = 0; i < m; i++) {
          if (i === at) paras.push(g.text);
          else paras.push([pickF(), pickF(), pickD()].slice(0, 2 + Math.floor(R() * 2)).join(JOIN) + (R() < 0.5 ? JOIN + pickF() : ''));
        }
        text = `# ${ds} ${pad(hh)}:${pad(mm)}\n\n` + paras.join('\n\n'); kind = 'journal';
      } else {
        text = `# ${ds} ${pad(hh)}:${pad(mm)}\n\n${g.text}`;
      }
    } else if (e - gold.length < pings.length) {
      const p = pings[e - gold.length];
      const lang = pickLang();
      text = `---\n## [${hms}] CLI Pipe\n\`\`\`text\n${pingLog(p.host, hms, lang)}\n\`\`\``; kind = 'log';
      goldHere.push('ping:' + p.host); entryLang = lang;
    } else {
      const r = R();
      if (r < 0.2) { text = `---\n## [${hms}] CLI Pipe\n\`\`\`text\n${buildLog(hms)}\n\`\`\``; kind = 'log'; }
      else if (r < 0.3) { text = `# ${ds} ${pad(hh)}:${pad(mm)}\n\n[[ @llm ${pickF()} ]]\n<!-- md-memo:res ${e} -->\n${pickF()}${JOIN}${pickD()}\n<!-- /md-memo:res -->`; kind = 'ai'; }
      else if (r < 0.55) { text = `# ${ds} ${pad(hh)}:${pad(mm)}\n\n${pickD()}${JOIN}${pickF()}`; }
      else if (r < 0.75) {
        const paras = Array.from({ length: 3 + Math.floor(R() * 3) }, () => pickF() + JOIN + (R() < 0.5 ? pickD() : pickF()));
        text = `# ${ds} ${pad(hh)}:${pad(mm)}\n\n` + paras.join('\n\n'); kind = 'journal';
      } else { text = `# ${ds} ${pad(hh)}:${pad(mm)}\n\n${pickF()}`; }
    }
    const id = `${file}#${e}`;
    truth.entries[id] = { kind, gold: goldHere };
    if (entryLang) truth.entryLang[id] = entryLang;
    goldHere.forEach((g) => { (truth.goldEntries[g] = truth.goldEntries[g] || []).push(id); });
    entries.push(text);
    entryCount++;
  }
  fs.writeFileSync(path.join(OUT, file), entries.join('\n\n') + '\n');
}

// queries with their relevant entries: the facts of the topic, in whichever language they were written
const goldOf = (ti) => (LANG === 'ja' ? TOPICS[ti].gold : LANG === 'en' ? TOPICS_EN[ti].gold : [...TOPICS[ti].gold, ...TOPICS_EN[ti].gold]);
const relOf = (ti) => goldOf(ti).flatMap((g) => truth.goldEntries[g] || []);
if (LANG !== 'en') TOPICS.forEach((t, ti) => t.q.forEach((q) => truth.queries.push({ q, type: 'semantic', lang: 'ja', topic: t.id, rel: relOf(ti) })));
if (LANG !== 'ja') TOPICS_EN.forEach((t, ti) => t.q.forEach((q) => truth.queries.push({ q, type: 'semantic', lang: 'en', topic: t.id, rel: relOf(ti) })));
if (LANG === 'mixed') MIXED_QUERIES.forEach((m) => { const ti = TOPICS.findIndex((t) => t.id === m.topic); truth.queries.push({ q: m.q, type: 'semantic', lang: 'mix', topic: m.topic, rel: relOf(ti) }); });
const pingRel = (h) => truth.goldEntries['ping:' + h] || [];
if (LANG !== 'en') HOSTS.forEach((h) => truth.queries.push({ q: `${h} のping結果`, type: 'identifier', lang: 'ja', topic: 'ping', rel: pingRel(h) }));
if (LANG !== 'ja') HOSTS.forEach((h) => truth.queries.push({ q: `ping results for ${h}`, type: 'identifier', lang: 'en', topic: 'ping', rel: pingRel(h) }));
fs.writeFileSync(path.join(path.dirname(OUT), 'truth.json'), JSON.stringify(truth));
const total = Object.values(fs.readdirSync(OUT)).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`lang ${LANG}, days ${DAYS}, entries ${entryCount}, files ${fs.readdirSync(OUT).length}, ${Math.round(total / 1024)} KB, queries ${truth.queries.length}`);
