#!/usr/bin/env node
// Live-answer speed report for Econ Bull Prep.
//
//   npm run stats                 # report on ./glass.log (the latest run)
//   npm run stats -- other.log    # report on another log file
//
// Every run is also appended to latency-history.csv so you can see the trend
// across runs/changes. glass.log is overwritten each time Glass starts, so run
// this after a session and before restarting if you want to keep that run.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const logPath = path.resolve(process.argv[2] || path.join(root, 'glass.log'));
const historyPath = path.join(root, 'latency-history.csv');

if (!fs.existsSync(logPath)) {
    console.error(`No log found at ${logPath}. Run Glass (npm start), use Listen, then try again.`);
    process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n');
const ts = l => {
    const t = Date.parse(l.slice(0, 24));
    return Number.isNaN(t) ? null : t;
};

const firstWords = []; // { ms, model }
const done = [];
const leads = [];
const failures = {}; // "provider/model: reason" -> count
const counts = {
    earlyStarted: 0,
    earlyKept: 0,
    finalRequests: 0,
    echoIgnored: 0,
    skipped: 0,
    noQuestion: 0,
    answered: 0,
};
const answers = [];

for (const l of lines) {
    let m;
    if ((m = l.match(/First words in (\d+)ms \(([^)]+)\)/))) firstWords.push({ ms: +m[1], model: m[2] });
    else if ((m = l.match(/\[LiveQA\] Done in (\d+)ms/))) done.push(+m[1]);
    else if ((m = l.match(/Answer lead vs end of question: ([+-]?\d+)ms/))) leads.push(+m[1]);
    else if (/\[LiveQA\] Early answer from partial/.test(l)) counts.earlyStarted++;
    else if (/Final turn matches early answer/.test(l)) counts.earlyKept++;
    else if (/Answering finished question/.test(l)) counts.finalRequests++;
    else if (/Ignoring mic echo/.test(l)) counts.echoIgnored++;
    else if (/\[LiveQA\] Skipping/.test(l)) counts.skipped++;
    else if ((m = l.match(/❌ \[LiveQA\] (\S+) failed: (.*)/))) {
        const reason = /404|not.?found|does not exist/i.test(m[2])
            ? '404 model not available'
            : /429|rate|quota/i.test(m[2])
            ? '429 rate limited'
            : /503|overload|unavailable/i.test(m[2])
            ? '503 overloaded'
            : /no response within/i.test(m[2])
            ? 'timed out'
            : m[2].slice(0, 60);
        const key = `${m[1]}: ${reason}`;
        failures[key] = (failures[key] || 0) + 1;
    } else if ((m = l.match(/📝 \[LiveQA\] Q: (.*?) \| A: (.*?) \|/))) {
        if (m[1] === 'NONE') counts.noQuestion++;
        else {
            counts.answered++;
            answers.push({ t: l.slice(11, 19), q: m[1], a: m[2] });
        }
    }
}

// Older logs (before the lead metric existed): estimate lead from the
// question's final transcript line vs the nearest "first words" line.
let leadSource = 'measured';
if (!leads.length) {
    leadSource = 'estimated';
    const fw = lines.filter(l => /First words in/.test(l)).map(ts).filter(Boolean);
    lines
        .filter(l => /Transcription complete: Them - .*\?/.test(l))
        .map(ts)
        .filter(Boolean)
        .forEach(q => {
            const near = fw.filter(t => Math.abs(t - q) <= 6000);
            if (near.length) leads.push(near.reduce((a, b) => (Math.abs(a - q) < Math.abs(b - q) ? a : b)) - q);
        });
}

function stats(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const pct = p => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    return {
        n: s.length,
        avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
        median: pct(50),
        p90: pct(90),
        min: s[0],
        max: s[s.length - 1],
    };
}
const fmt = st =>
    st ? `n=${st.n}  avg ${st.avg}ms  median ${st.median}ms  p90 ${st.p90}ms  min ${st.min}ms  max ${st.max}ms` : 'no data';

const fwStats = stats(firstWords.map(x => x.ms));
const doneStats = stats(done);
const leadStats = stats(leads);
const beforeEnd = leads.filter(x => x < 0).length;
const underOneSec = firstWords.filter(x => x.ms < 1000).length;
const byModel = {};
firstWords.forEach(x => (byModel[x.model] = byModel[x.model] || []).push(x.ms));

const startMs = lines.map(ts).find(Boolean);
const pad = n => String(n).padStart(2, '0');
const runStart = startMs
    ? (d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date(startMs))
    : 'unknown';
let commit = '';
try {
    commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
} catch (_) {}

console.log(`\n=== Live answer speed — run started ${runStart} (code ${commit || '?'}) ===\n`);
console.log(`First words on screen   ${fmt(fwStats)}`);
console.log(`Full answer finished    ${fmt(doneStats)}`);
console.log(
    `Lead vs end of question ${fmt(leadStats)}  (${leadSource}; negative = answer appeared before the speaker finished)`
);
if (leads.length) console.log(`  → answer was already showing before the question ended: ${beforeEnd}/${leads.length}`);
if (firstWords.length) console.log(`  → first words under 1 second: ${underOneSec}/${firstWords.length}`);

console.log('\nBy model (first words):');
Object.entries(byModel).forEach(([m, a]) => console.log(`  ${m.padEnd(36)} ${fmt(stats(a))}`));

console.log('\nRequests:');
console.log(`  early answers started ${counts.earlyStarted}, kept when question finished ${counts.earlyKept}`);
console.log(`  answered after question finished ${counts.finalRequests}`);
console.log(`  real answers ${counts.answered}, wasted on non-questions (Q: NONE) ${counts.noQuestion}`);
console.log(`  mic echoes ignored ${counts.echoIgnored}, skipped by rate guard ${counts.skipped}`);
const fails = Object.entries(failures);
console.log(`  failures/fallbacks: ${fails.length ? '' : 'none'}`);
fails.forEach(([k, v]) => console.log(`    ${v}× ${k}`));

if (answers.length) {
    console.log('\nAnswers (check against the official ones):');
    answers.forEach(a => console.log(`  ${a.t}  Q: ${a.q}\n            A: ${a.a}`));
}

// Append to history for trend tracking.
const header =
    'run_start,commit,answers,first_avg_ms,first_median_ms,first_p90_ms,done_avg_ms,done_median_ms,lead_median_ms,before_end_pct,under_1s_pct,wasted,failures,models\n';
const row = [
    runStart,
    commit,
    counts.answered,
    fwStats?.avg ?? '',
    fwStats?.median ?? '',
    fwStats?.p90 ?? '',
    doneStats?.avg ?? '',
    doneStats?.median ?? '',
    leadStats?.median ?? '',
    leads.length ? Math.round((100 * beforeEnd) / leads.length) : '',
    firstWords.length ? Math.round((100 * underOneSec) / firstWords.length) : '',
    counts.noQuestion,
    fails.reduce((a, [, v]) => a + v, 0),
    Object.keys(byModel).join(' '),
].join(',');

let history = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : header;
if (!history.includes(row.split(',').slice(0, 2).join(','))) {
    history += row + '\n';
    fs.writeFileSync(historyPath, history);
}
const rows = history.trim().split('\n').slice(1);
if (rows.length > 1) {
    console.log('\nHistory (latest last):');
    console.log('  run start              commit   answers  first-median  first-p90  lead-median  before-end  wasted  fails');
    rows.slice(-8).forEach(r => {
        const c = r.split(',');
        console.log(
            `  ${String(c[0]).padEnd(22)} ${String(c[1]).padEnd(8)} ${String(c[2]).padStart(7)}  ${String(
                c[4]
            ).padStart(9)}ms  ${String(c[5]).padStart(7)}ms  ${String(c[8]).padStart(9)}ms  ${String(c[9]).padStart(8)}%  ${String(
                c[11]
            ).padStart(6)}  ${String(c[12]).padStart(5)}`
        );
    });
}
console.log('');
