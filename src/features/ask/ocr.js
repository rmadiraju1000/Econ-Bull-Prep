// Fast on-device text recognition (macOS Vision framework) for "Ask about my screen".
// Runs through osascript's JavaScript bridge, so nothing needs to be compiled or installed.
// Typical time on Apple Silicon: ~0.3–0.8 s for a full screen.

const path = require('node:path');
const fs = require('node:fs');
const os = require('os');
const { execFile } = require('child_process');

const JXA = `
ObjC.import('Vision');
ObjC.import('Foundation');
function run(argv) {
    const url = $.NSURL.fileURLWithPath(argv[0]);
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
    const req = $.VNRecognizeTextRequest.alloc.init;
    req.setRecognitionLevel(argv[1] === 'fast' ? 1 : 0); // 0 = accurate, 1 = fast
    req.setUsesLanguageCorrection(true);
    handler.performRequestsError($.NSArray.arrayWithObject(req), null);
    const results = req.results;
    if (!results) return '';
    const rows = [];
    for (let i = 0; i < results.count; i++) {
        const obs = results.objectAtIndex(i);
        const cands = obs.topCandidates(1);
        if (!cands || !cands.count) continue;
        const bb = obs.boundingBox;
        rows.push({ y: bb.origin.y + bb.size.height, x: bb.origin.x, t: cands.objectAtIndex(0).string.js });
    }
    // Vision's origin is bottom-left: sort top-to-bottom, then left-to-right.
    rows.sort((a, b) => Math.round((b.y - a.y) * 200) || a.x - b.x);
    return rows.map(r => r.t).join('\\n');
}
`;

let scriptPath = null;
let disabledUntil = 0;

function ensureScript() {
    if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
    scriptPath = path.join(os.tmpdir(), 'glass-ocr.js');
    fs.writeFileSync(scriptPath, JXA);
    return scriptPath;
}

/** Returns the text on the image (top to bottom), or '' if OCR isn't available. */
function recognizeText(imagePath, { level = 'accurate', timeoutMs = 4000 } = {}) {
    if (process.platform !== 'darwin' || Date.now() < disabledUntil) return Promise.resolve('');
    const started = Date.now();
    return new Promise(resolve => {
        execFile(
            'osascript',
            ['-l', 'JavaScript', ensureScript(), imagePath, level],
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    console.warn(`[OCR] Text recognition failed: ${(stderr || err.message || '').toString().slice(0, 200)}`);
                    disabledUntil = Date.now() + 5 * 60 * 1000; // don't keep retrying a broken setup
                    return resolve('');
                }
                const text = (stdout || '').trim();
                console.log(`⏱ [OCR] Read ${text.length} characters from the screen in ${Date.now() - started}ms`);
                resolve(text);
            }
        );
    });
}

module.exports = { recognizeText };
