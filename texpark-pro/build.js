/* Builds the two shippable forms from the source in this folder, so the deploy
   bundle and the single-file app can never drift behind the code again:
     ../texpark-deploy   folder to host (js/css kept as separate files)
     ../texpark-pro.html one self-contained file to email or run from a USB stick
   Run: node build.js                                                        */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const outDir = path.join(root, '..', 'texpark-deploy');
const outFile = path.join(root, '..', 'texpark-pro.html');

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('index.html');
const css = read('css/app.css');
const scripts = ['js/db.js', 'js/voice.js', 'js/sync.js', 'js/app.js'].map(read);

/* ---- 1. the hostable folder ---- */
/* Clear only the files this build owns, so the hand-written hosting guide and
   anything else the user dropped in there is not destroyed. */
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'Code.gs']) {
  fs.rmSync(path.join(outDir, f), { force: true });
}
for (const f of ['db.js', 'voice.js', 'sync.js', 'app.js']) {
  fs.rmSync(path.join(outDir, 'js', f), { force: true });
}
fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'Code.gs']) {
  fs.copyFileSync(path.join(root, f), path.join(outDir, f));
}
for (const f of ['db.js', 'voice.js', 'sync.js', 'app.js']) {
  fs.copyFileSync(path.join(root, 'js', f), path.join(outDir, 'js', f));
}
fs.copyFileSync(path.join(root, 'css', 'app.css'), path.join(outDir, 'css', 'app.css'));

/* ---- 2. the single self-contained file ---- */
/* Offline install does not work from file://, so the single file drops the
   manifest and the service worker and just inlines everything else. */
let single = html
  .replace(/[ \t]*<link rel="manifest"[^>]*>\s*\n?/, '')
  .replace(/[ \t]*<link rel="stylesheet" href="css\/app\.css">/, '<style>\n' + css + '\n</style>')
  .replace(/[ \t]*<script src="js\/[a-z]+\.js"><\/script>\s*\n?/g, '');
const bundle = scripts.map((s, i) => '<script>\n/* bundle ' + i + ' */\n' + s + '\n</script>').join('\n');
single = single.replace('</body>', bundle + '\n</body>');
fs.writeFileSync(outFile, single);

const kb = (p) => Math.round(fs.statSync(p).size / 1024);
console.log('built folder  ' + outDir + '  (' + kb(path.join(outDir, 'index.html')) + ' KB html + js/css)');
console.log('built file    ' + outFile + '  (' + kb(outFile) + ' KB, self-contained)');

/* A quick sanity check that the bundle really carries the current code. */
const must = ['deviceTag', 'cloudBackupNow', 'cloudRestore', 'restoreFromJSONText'];
const missing = must.filter(m => !single.includes(m));
if (missing.length) { console.error('single file is missing: ' + missing.join(', ')); process.exit(1); }
console.log('verified: every new cloud/device function is inside the single file');