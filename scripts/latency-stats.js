#!/usr/bin/env node
// Live-answer report for Econ Bull Prep.
//
//   npm run stats                 # report on ./glass.log (the latest run)
//   npm run stats -- other.log    # report on another log file
//
// Reports speed (first words / full answer / lead vs end of question), accuracy
// from your ✓/✗ ratings, double-check results, model routing, wasted requests,
// failures, and every answer given. Each run is appended to latency-history.csv
// so you can see trends. glass.log is overwritten each time Glass starts, so run
// this after a session and before restarting.

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
const clock = l => {
    const t = ts(l);
    return t ? new Date(t).toTimeString().slice(0, 8) : '';
};

const firstWords = []; // { ms, model, route, early }
const done = [];
const leadEvents = []; // { t, ms }
const answerEvents = []; // { t, q, a, time }
const failures = {};
const ratings = []; // { verdict, model, q, a }
const verify = { ok: 0, corrected: 0, failed: 0, ms: [], fixes: [] };
const c = {
    earlyStarted: 0,
    earlyKept: 0,
    finalRequests: 0,
    echoIgnored: 0,
    micIgnored: 0,
    rateGuard: 0,
    none: 0,
    same: 0,
    alreadyAnswered: 0,
    answered: 0,
};

for (const l of lines) {
    let m;
    if ((m = l.match(/First words in (\d+)ms \(([^,)]+)(?:, (low|medium|high))?(?:, (hard|simple))?(, early)?\)/))) {
        firstWords.push({ ms: +m[1], model: m[2], route: m[4] || 'n/a', early: !!m[5] });
    } else if ((m = l.match(/\[LiveQA\] Done in (\d+)ms/))) done.push(+m[1]);
    else if ((m = l.match(/Answer lead vs end of question: ([+-]?\d+)ms(?: \(#(\d+)\))?/))) leadEvents.push({ t: ts(l), ms: +m[1], seq: m[2] });
    else if (/\[LiveQA\] Early answer from partial/.test(l)) c.earlyStarted++;
    else if (/Final turn matches early answer/.test(l)) c.earlyKept++;
    else if (/Answering finished question/.test(l)) c.finalRequests++;
    else if (/Ignoring mic echo/.test(l)) c.echoIgnored++;
    else if (/Ignoring call-audio-only mode/.test(l)) c.micIgnored++;
    else if (/\[LiveQA\] Skipping/.test(l)) c.rateGuard++;
    else if (/\[LiveQA\] Already answered/.test(l)) c.alreadyAnswered++;
    else if ((m = l.match(/🔍 \[LiveQA\] Double-check (OK|CORRECTED) in (\d+)ms(.*)/))) {
        verify[m[1] === 'OK' ? 'ok' : 'corrected']++;
        verify.ms.push(+m[2]);
        if (m[1] === 'CORRECTED') verify.fixes.push(m[3].replace(/^.*?\| /, '').slice(0, 160));
    } else if (/Double-check failed/.test(l)) verify.failed++;
    else if ((m = l.match(/🔍 \[LiveQA\] 120B review \(#\d+\) in (\d+)ms/))) verify.ms.push(+m[1]);
    else if (/🔍 \[LiveQA\] 120B agrees/.test(l)) verify.ok++;
    else if ((m = l.match(/🔍 \[LiveQA\] 120B CORRECTED \(#\d+\) \| (.*)/))) {
        verify.corrected++;
        verify.fixes.push(m[1].slice(0, 160));
    }
    else if ((m = l.match(/🏷 \[LiveQA\] Rated (CORRECT|WRONG) \(#\d+, ([^)]*)\) \| Q: (.*?) \| A: (.*)/))) {
        ratings.push({ verdict: m[1], model: m[2], q: m[3], a: m[4] });
    } else if ((m = l.match(/❌ \[LiveQA\] (\S+) failed: (.*)/))) {
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
    } else if ((m = l.match(/📝 \[LiveQA\] (?:\(#(\d+)\) )?Q: (.*?) \| A: (.*?) \|/))) {
        if (m[2] === 'NONE') c.none++;
        else if (m[2] === 'SAME') c.same++;
        else {
            c.answered++;
            answerEvents.push({ t: ts(l), time: clock(l), seq: m[1], q: m[2], a: m[3] });
        }
    }
}

// Pair each measured lead with the answer it belongs to (by request id; older logs: nearest
// answer line). Requests that found no question (NONE/SAME) are left out.
const perQuestion = leadEvents
    .map(e => {
        if (e.seq) {
            const a = answerEvents.find(x => x.seq === e.seq);
            return a ? { ms: e.ms, q: a.q } : null;
        }
        const near = answerEvents.reduce((best, a) => (!best || Math.abs(a.t - e.t) < Math.abs(best.t - e.t) ? a : best), null);
        return near && Math.abs(near.t - e.t) < 15000 ? { ms: e.ms, q: near.q } : null;
    })
    .filter(Boolean);

function stats(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const pct = p => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    return { n: s.length, avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), median: pct(50), p90: pct(90), min: s[0], max: s[s.length - 1] };
}
const fmt = st => (st ? `n=${st.n}  avg ${st.avg}ms  median ${st.median}ms  p90 ${st.p90}ms  min ${st.min}ms  max ${st.max}ms` : 'no data');
const pctOf = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');

const fwStats = stats(firstWords.map(x => x.ms));
const doneStats = stats(done);
const leadStats = stats(perQuestion.map(x => x.ms));
const beforeEnd = perQuestion.filter(x => x.ms < 0).length;
const underOne = firstWords.filter(x => x.ms < 1000).length;
const requests = firstWords.length;
const wasted = c.none + c.same + c.alreadyAnswered;
const ratedRight = ratings.filter(r => r.verdict === 'CORRECT').length;

const startMs = lines.map(ts).find(Boolean);
const pad = n => String(n).padStart(2, '0');
const runStart = startMs
    ? (d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`)(new Date(startMs))
    : 'unknown';
let commit = '';
try {
    commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch (_) {}

const out = [];
const p = s => out.push(s);
p(`\n=== Econ Bull Prep live answers — run ${runStart} (code ${commit || '?'}) ===\n`);
p('SPEED');
p(`  First words on screen     ${fmt(fwStats)}`);
p(`  Full answer finished      ${fmt(doneStats)}`);
p(`  Lead vs end of question   ${fmt(leadStats)}   (negative = before the speaker finished)`);
if (perQuestion.length) p(`  Answer showing before the question ended: ${beforeEnd}/${perQuestion.length}`);
if (requests) p(`  First words under 1 second: ${underOne}/${requests} (${pctOf(underOne, requests)})`);

p('\nBY MODEL / ROUTE (first words)');
const groups = {};
firstWords.forEach(x => (groups[`${x.model} [${x.route}]`] = groups[`${x.model} [${x.route}]`] || []).push(x.ms));
Object.entries(groups).forEach(([k, a]) => p(`  ${k.padEnd(40)} ${fmt(stats(a))}`));

p('\nACCURACY');
if (ratings.length) {
    p(`  Your ratings: ${ratedRight}/${ratings.length} right (${pctOf(ratedRight, ratings.length)})`);
    const byModel = {};
    ratings.forEach(r => {
        byModel[r.model] = byModel[r.model] || [0, 0];
        byModel[r.model][1]++;
        if (r.verdict === 'CORRECT') byModel[r.model][0]++;
    });
    Object.entries(byModel).forEach(([m, [r, n]]) => p(`    ${m.padEnd(30)} ${r}/${n} right`));
    ratings.filter(r => r.verdict === 'WRONG').forEach(r => p(`    ✗ ${r.q}  →  ${r.a}`));
} else p('  No ✓/✗ ratings yet — click ✓ Right / ✗ Wrong on answer cards to track accuracy.');
const vTotal = verify.ok + verify.corrected;
if (vTotal || verify.failed) {
    p(`  Double-check: ${vTotal} checked, ${verify.corrected} corrected (${pctOf(verify.corrected, vTotal)}), ${verify.failed} failed; avg ${stats(verify.ms)?.avg ?? '-'}ms`);
    verify.fixes.forEach(f => p(`    ✎ ${f}`));
}

p('\nREQUESTS');
p(`  Total answer requests ${requests}; real answers ${c.answered}`);
p(`  Wasted: ${wasted} (${pctOf(wasted, requests)})  — not a question yet ${c.none}, repeat/chatter (SAME) ${c.same}, already answered ${c.alreadyAnswered}`);
p(`  Early answers started ${c.earlyStarted}, confirmed when the question finished ${c.earlyKept}; answered after the question finished ${c.finalRequests}`);
p(`  Ignored: mic echoes ${c.echoIgnored}, mic (call-audio-only) ${c.micIgnored}; held back by rate guard ${c.rateGuard}`);
const fails = Object.entries(failures);
p(`  Failures/fallbacks: ${fails.length ? '' : 'none'}`);
fails.forEach(([k, v]) => p(`    ${v}× ${k}`));

if (perQuestion.length) {
    p('\nPER QUESTION (lead vs end of question)');
    perQuestion.forEach(x => p(`  ${(x.ms >= 0 ? '+' : '') + (x.ms / 1000).toFixed(2)}s  ${x.q}`));
}
if (answerEvents.length) {
    p('\nANSWERS GIVEN (check against the official ones)');
    answerEvents.forEach(a => p(`  ${a.time}  Q: ${a.q}\n            A: ${a.a}`));
}

// History for trends.
const header =
    'run_start,commit,requests,answers,first_median_ms,first_p90_ms,done_median_ms,lead_median_ms,before_end_pct,under_1s_pct,wasted_pct,rated,rated_right_pct,checked,corrected,failures\n';
const row = [
    runStart,
    commit,
    requests,
    c.answered,
    fwStats?.median ?? '',
    fwStats?.p90 ?? '',
    doneStats?.median ?? '',
    leadStats?.median ?? '',
    perQuestion.length ? Math.round((100 * beforeEnd) / perQuestion.length) : '',
    requests ? Math.round((100 * underOne) / requests) : '',
    requests ? Math.round((100 * wasted) / requests) : '',
    ratings.length,
    ratings.length ? Math.round((100 * ratedRight) / ratings.length) : '',
    vTotal,
    verify.corrected,
    fails.reduce((a, [, v]) => a + v, 0),
].join(',');

let history = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : header;
if (!history.startsWith(header)) {
    fs.renameSync(historyPath, historyPath.replace(/\.csv$/, '-v1.csv')); // older column layout
    history = header;
}
const key = `${runStart},${commit},`;
const kept = history.trim().split('\n').filter(r => !r.startsWith(key));
history = kept.join('\n') + '\n' + row + '\n';
fs.writeFileSync(historyPath, history);

const rows = history.trim().split('\n').slice(1);
if (rows.length > 1) {
    p('\nHISTORY (latest last)');
    p('  run start          commit   answers  first-med  first-p90  lead-med  before-end  wasted  rated-right');
    rows.slice(-10).forEach(r => {
        const x = r.split(',');
        p(
            `  ${x[0].padEnd(18)} ${x[1].padEnd(8)} ${x[3].padStart(7)}  ${String(x[4]).padStart(7)}ms  ${String(x[5]).padStart(7)}ms  ${String(x[7]).padStart(6)}ms  ${String(x[8]).padStart(9)}%  ${String(x[10]).padStart(5)}%  ${x[12] ? x[12] + '%' : '-'}`
        );
    });
}
console.log(out.join('\n') + '\n');
