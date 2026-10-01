/* Real tests for the Android side.
 *
 * There is no emulator here (no KVM), so what can be tested honestly is tested:
 * the shipped SiteUrl class is compiled and run on a plain JVM. The address the
 * owner types is the one input that can send the whole app to a dead page, so
 * every way it can go wrong is covered - including the ways that would otherwise
 * pass silently and produce a "Site ta khola gelo na" on someone's phone.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'android-src', 'com', 'texpark', 'pro', 'SiteUrl.java');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'siteurl-'));

/* Resolved once and reused, so setting JAVAC actually moves every javac call
   rather than only the first one. */
const JAVAC = process.env.JAVAC || 'javac';
const JAVA = process.env.JAVA || (process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java');

function compile() {
  if (!fs.existsSync(SRC)) throw new Error('missing ' + SRC);
  try {
    execFileSync(JAVAC, ['-nowarn', '-d', OUT, SRC], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('javac not found (' + JAVAC + '). Install a JDK or point JAVAC at one; '
        + 'otherwise these 12 tests report a false failure on a machine with no JDK.');
    }
    throw e;
  }
}

// Compile once; every case below then runs against the real class.
test('android: SiteUrl compiles against the shipped source', () => {
  compile();
  const cls = path.join(OUT, 'com', 'texpark', 'pro', 'SiteUrl.class');
  assert.ok(fs.existsSync(cls), 'SiteUrl.class should be produced');
  assert.ok(fs.statSync(cls).size > 0, 'class file must not be empty');
  assert.ok(!fs.readFileSync(SRC, 'utf8').includes('import android.'),
    'SiteUrl must stay free of Android imports so it stays testable');
});

// Run one value through the real class and return what it produced.
function normalise(input) {
  const script = `
    public class Probe {
      public static void main(String[] a) {
        String r = com.texpark.pro.SiteUrl.normalise(a.length > 0 ? a[0] : null);
        System.out.print(r == null ? "<<null>>" : r);
      }
    }`;
  const p = path.join(OUT, 'Probe.java');
  fs.writeFileSync(p, script);
  execFileSync(JAVAC, ['-nowarn', '-cp', OUT, '-d', OUT, p], { stdio: 'pipe' });
  return execFileSync(JAVA, ['-cp', OUT, 'Probe', input], { encoding: 'utf8' });
}

test('android: https is added when the owner leaves it out', () => {
  assert.strictEqual(normalise('texpark.netlify.app'), 'https://texpark.netlify.app');
});

test('android: a pasted plain-http address is upgraded, not refused', () => {
  // Phones and old bookmarks hand out http links; loading one would be blocked
  // as mixed content, so it is upgraded instead.
  assert.strictEqual(normalise('http://texpark.netlify.app'), 'https://texpark.netlify.app');
});

test('android: a trailing slash does not create a second, broken address', () => {
  assert.strictEqual(normalise('https://texpark.netlify.app/'), 'https://texpark.netlify.app');
  assert.strictEqual(normalise('https://texpark.netlify.app///'), 'https://texpark.netlify.app');
});

test('android: the trailing slash is not stripped off a path', () => {
  assert.strictEqual(normalise('https://example.com/app/'), 'https://example.com/app');
});

test('android: spaces around what was typed are ignored', () => {
  assert.strictEqual(normalise('  texpark.netlify.app  '), 'https://texpark.netlify.app');
});

test('android: a real-looking host with a port and path is kept whole', () => {
  assert.strictEqual(normalise('https://example.com:8443/biz'),
    'https://example.com:8443/biz');
});

test('android: empty input is refused rather than saved', () => {
  assert.strictEqual(normalise(''), '<<null>>');
  assert.strictEqual(normalise('   '), '<<null>>');
});

test('android: the company name is not mistaken for an address', () => {
  // "Texpark Buying House" has spaces and no dot - saving it would leave the
  // owner on a dead page with no idea why.
  assert.strictEqual(normalise('Texpark Buying House'), '<<null>>');
  assert.strictEqual(normalise('Texpark'), '<<null>>');
});

test('android: a bare word is refused instead of becoming https://word', () => {
  assert.strictEqual(normalise('localhost'), '<<null>>');
});

test('android: a host starting or ending with a dot is refused', () => {
  assert.strictEqual(normalise('.netlify.app'), '<<null>>');
  assert.strictEqual(normalise('texpark.'), '<<null>>');
});

test('android: null is refused', () => {
  const script = `
    public class NullProbe {
      public static void main(String[] a) {
        String r = com.texpark.pro.SiteUrl.normalise(null);
        System.out.print(r == null ? "<<null>>" : r);
      }
    }`;
  const p = path.join(OUT, 'NullProbe.java');
  fs.writeFileSync(p, script);
  execFileSync(JAVAC, ['-nowarn', '-cp', OUT, '-d', OUT, p], { stdio: 'pipe' });
  const out = execFileSync(JAVA, ['-cp', OUT, 'NullProbe'], { encoding: 'utf8' });
  assert.strictEqual(out, '<<null>>');
});

/* ---------------------------------------------------------------- updater
 *
 * The pieces that decide whether a phone takes a new build at all. A wrong
 * answer here is invisible: the phone keeps running the version with the bug
 * the owner already reported, and nothing on screen says why. Updater is free
 * of Android imports precisely so the real class can be exercised like this.
 */
const UPDATER_SRC = path.join(ROOT, 'android-src', 'com', 'texpark', 'pro', 'Updater.java');

test('android: Updater compiles without any Android import', () => {
  const src = fs.readFileSync(UPDATER_SRC, 'utf8');
  assert.ok(!src.includes('import android.'), 'Updater must stay testable off-device');
  execFileSync(JAVAC, ['-nowarn', '-d', OUT, UPDATER_SRC], { stdio: 'pipe' });
  assert.ok(fs.existsSync(path.join(OUT, 'com', 'texpark', 'pro', 'Updater.class')));
});

// Drives the real Updater with a fake network and a real temp folder.
function updaterProbe(body, extraArgs) {
  const script = `
    import com.texpark.pro.Updater;
    import java.io.File;
    import java.nio.file.Files;
    import java.util.*;

    public class UpProbe {
      ${body}
    }
  `;
  const p = path.join(OUT, 'UpProbe.java');
  fs.writeFileSync(p, script);
  execFileSync(JAVAC, ['-nowarn', '-cp', OUT, '-d', OUT, p], { stdio: 'pipe' });
  return execFileSync(JAVA, ['-cp', OUT, 'UpProbe', OUT].concat(extraArgs || []),
    { encoding: 'utf8' });
}

/* Runs a throwaway HTTP server on a loopback port and hands its base URL to
   `body`. Real sockets are used rather than a stubbed Fetcher because the bug
   being guarded lives in how a host answers, not in the parsing. */
function withServer(server, body) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      Promise.resolve()
        .then(() => body(base))
        .then(v => { server.close(() => resolve(v)); },
              e => { server.close(() => reject(e)); });
    });
  });
}

test('android: a newer version wins and an older one is refused', () => {
  const out = updaterProbe(`
    public static void main(String[] a) {
      System.out.print(
        (Updater.compareVersions("2026-09-22.7", "2026-09-22.6") > 0) + "," +
        (Updater.compareVersions("2026-09-22.6", "2026-09-22.7") < 0) + "," +
        (Updater.compareVersions("2026-09-22.6", "2026-09-22.6") == 0));
    }`);
  assert.strictEqual(out, 'true,true,true');
});

test('android: the tenth fix of a day is newer than the ninth', () => {
  // The bug this guards: string order puts .10 before .9, so the phone would
  // refuse the tenth fix forever and silently.
  const out = updaterProbe(`
    public static void main(String[] a) {
      System.out.print(Updater.compareVersions("2026-09-22.10", "2026-09-22.9") > 0);
    }`);
  assert.strictEqual(out, 'true');
});

test('android: a fresh install takes the bundled build', () => {
  const out = updaterProbe(`
    public static void main(String[] a) {
      System.out.print(Updater.shouldInstallBundled("2026-09-22.7", "") + "," +
        Updater.shouldInstallBundled("2026-09-22.7", "2026-09-22.7") + "," +
        Updater.shouldInstallBundled("2026-09-22.6", "2026-09-22.7"));
    }`);
  assert.strictEqual(out, 'true,false,false');
});

test('android: an update installs every file, and the app opens from the new build', () => {
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      File dest = new File(a[0], "site1");
      new File(dest, "js").mkdirs();
      Files.write(new File(dest, "js/app.js").toPath(),
        "old\\nconst APP_VERSION = '2026-09-22.6';\\n".getBytes("UTF-8"));
      Files.write(new File(dest, "index.html").toPath(), "old".getBytes("UTF-8"));

      final Map<String, byte[]> remote = new HashMap<String, byte[]>();
      remote.put("index.html", ("<html><head>\\n"
        + "<link rel=\\"stylesheet\\" href=\\"css/app.css\\">\\n"
        + "<script src=\\"js/app.js\\"></script>\\n"
        + "</head><body></body></html>").getBytes("UTF-8"));
      remote.put("css/app.css", "body{color:red}".getBytes("UTF-8"));
      remote.put("js/app.js", "new\\nconst APP_VERSION = '2026-09-22.7';\\n".getBytes("UTF-8"));

      boolean ok = Updater.applyUpdate(dest, "2026-09-22.6", new Updater.Fetcher() {
        public byte[] get(String p) { return remote.get(p); }
      });
      System.out.print(ok + "," +
        new File(dest, "css/app.css").isFile() + "," +
        new File(dest, "js/app.js").isFile() + "," +
        new String(Files.readAllBytes(new File(dest, "index.html").toPath()), "UTF-8").startsWith("<html") + "," +
        new File(a[0], "site1.old").exists() + "," +
        new File(a[0], "site1.new").exists());
    }`);
  assert.strictEqual(out, 'true,true,true,true,false,false');
});

test('android: the version comes from app.js, not from a file a host could fake', () => {
  const out = updaterProbe(`
    public static void main(String[] a) {
      System.out.print(Updater.versionIn("const APP_VERSION = '2026-09-22.10';\\n")
        + "," + Updater.versionIn("no version here")
        + "," + Updater.versionIn(null));
    }`);
  assert.strictEqual(out, '2026-09-22.10,,');
});

test('android: the file list is read out of the the app markup', () => {
  const out = updaterProbe(`
    public static void main(String[] a) {
      String html = "<link rel=\\"stylesheet\\" href=\\"css/app.css\\">"
        + "<script src=\\"js/db.js\\"></script>"
        + "<script src=\\"js/app.js\\"></script>"
        + "<img src=\\"icon-192.png?v=3\\">"
        + "<a href=\\"#/settings\\">x</a>"
        + "<a href=\\"https://example.com/x.js\\">y</a>"
        + "<a href=\\"mailto:md@example.com\\">z</a>";
      System.out.print(Updater.referencedFiles(html).toString());
    }`);
  assert.strictEqual(out, '[css/app.css, js/db.js, js/app.js, icon-192.png]');
});

test('android: a half-uploaded build is thrown away, never half-applied', () => {
  // One file missing on the host is exactly what a deploy in progress looks
  // like. Installing what did arrive would leave the app a mix of two versions.
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      File dest = new File(a[0], "site2");
      new File(dest, "js").mkdirs();
      Files.write(new File(dest, "js/app.js").toPath(),
        "old\\nconst APP_VERSION = '2026-09-22.6';\\n".getBytes("UTF-8"));
      Files.write(new File(dest, "index.html").toPath(), "old".getBytes("UTF-8"));

      final Map<String, byte[]> remote = new HashMap<String, byte[]>();
      remote.put("index.html", ("<html><head><script src=\\"js/app.js\\"></script>"
        + "<link href=\\"css/app.css\\"></head></html>").getBytes("UTF-8"));
      remote.put("css/app.css", "body{}".getBytes("UTF-8"));
      // js/app.js is deliberately absent, so the build can never be complete

      boolean ok = Updater.applyUpdate(dest, "2026-09-22.6", new Updater.Fetcher() {
        public byte[] get(String p) { return remote.get(p); }
      });
      System.out.print(ok + "," +
        new String(Files.readAllBytes(new File(dest, "index.html").toPath()), "UTF-8") + "," +
        new File(a[0], "site2.new").exists());
    }`);
  assert.strictEqual(out, 'false,old,false');
});

test('android: markup saved under a .js name is refused', () => {
  // The host answering a missing script with the app page is the failure that
  // survives the whole download: the phone would install a build whose script
  // is a page of HTML and break on open.
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      File dest = new File(a[0], "site3");
      dest.mkdirs();
      Files.write(new File(dest, "index.html").toPath(), "old".getBytes("UTF-8"));
      final Map<String, byte[]> remote = new HashMap<String, byte[]>();
      remote.put("index.html", "<html><head><script src=\\"js/app.js\\"></script></head></html>"
        .getBytes("UTF-8"));
      remote.put("js/app.js", "<!doctype html><html>the app page</html>".getBytes("UTF-8"));
      System.out.print(Updater.applyUpdate(dest, "2026-09-22.6", new Updater.Fetcher() {
        public byte[] get(String p) { return remote.get(p); }
      }) + "," + new String(Files.readAllBytes(
        new File(dest, "index.html").toPath()), "UTF-8"));
    }`);
  assert.strictEqual(out, 'false,old');
});

test('android: a dead host leaves the phone on the build it has', () => {
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      File dest = new File(a[0], "site4");
      new File(dest, "js").mkdirs();
      Files.write(new File(dest, "js/app.js").toPath(),
        "const APP_VERSION = '2026-09-22.7';\\n".getBytes("UTF-8"));
      boolean ok = Updater.applyUpdate(dest, "2026-09-22.7", new Updater.Fetcher() {
        public byte[] get(String p) { return null; }
      });
      System.out.print(ok + "," + Updater.versionIn(new String(Files.readAllBytes(
        new File(dest, "js/app.js").toPath()), "UTF-8")));
    }`);
  assert.strictEqual(out, 'false,2026-09-22.7');
});

test('android: a path in the markup cannot escape the app folder', () => {
  // The markup is fetched from the network; a ../../ href in it must not be
  // able to make the updater read or write outside the app's own directory.
  const out = updaterProbe(`
    public static void main(String[] a) {
      System.out.print(Updater.referencedFiles(
        "<script src=\\"../../evil.js\\"></script>"
        + "<script src=\\"/etc/passwd\\"></script>"
        + "<script src=\\"js/app.js\\"></script>").toString());
    }`);
  assert.strictEqual(out, '[js/app.js]');
});

test('android: a blank version on the host is not an update', () => {
  // A host answering with an empty script (a broken deploy, a captive portal
  // login page) must not be treated as a newer build.
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      File dest = new File(a[0], "site5");
      dest.mkdirs();
      Files.write(new File(dest, "index.html").toPath(), "old".getBytes("UTF-8"));
      final Map<String, byte[]> remote = new HashMap<String, byte[]>();
      remote.put("index.html", "<html><script src=\\"js/app.js\\"></script></html>".getBytes("UTF-8"));
      remote.put("js/app.js", "   \\n".getBytes("UTF-8"));
      boolean ok = Updater.applyUpdate(dest, "2026-09-22.7", new Updater.Fetcher() {
        public byte[] get(String p) { return remote.get(p); }
      });
      System.out.print(ok + "," + new String(Files.readAllBytes(
        new File(dest, "index.html").toPath()), "UTF-8"));
    }`);
  assert.strictEqual(out, 'false,old');
});

test('android: a fallback page in place of the app script is refused', () => {
  // The host answering for js/app.js with the app page is the case that would
  // otherwise decide the phone is up to date forever: the page is not a
  // version, so nothing ever compares as newer and the fix never arrives.
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      File dest = new File(a[0], "site6");
      dest.mkdirs();
      Files.write(new File(dest, "index.html").toPath(), "old".getBytes("UTF-8"));
      final Map<String, byte[]> remote = new HashMap<String, byte[]>();
      remote.put("js/app.js", ("<!doctype html><html>"
        + "<script src=\\"js/app.js\\"></script>the app page</html>").getBytes("UTF-8"));
      remote.put("index.html", "<html><script src=\\"js/app.js\\"></script></html>".getBytes("UTF-8"));
      boolean ok = Updater.applyUpdate(dest, "2026-09-22.7", new Updater.Fetcher() {
        public byte[] get(String p) { return remote.get(p); }
      });
      System.out.print(ok + "," + new String(Files.readAllBytes(
        new File(dest, "index.html").toPath()), "UTF-8"));
    }`);
  assert.strictEqual(out, 'false,old');
});

test('android: markup with no app script is not the app', () => {
  // If the fallback page ever loses the script tag, the file list it yields
  // would be missing a file the app needs. Such markup is refused outright.
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      File dest = new File(a[0], "site7");
      dest.mkdirs();
      Files.write(new File(dest, "index.html").toPath(), "old".getBytes("UTF-8"));
      final Map<String, byte[]> remote = new HashMap<String, byte[]>();
      remote.put("js/app.js", "const APP_VERSION = '2026-09-22.8';\\n".getBytes("UTF-8"));
      remote.put("index.html", "<html><body><a href=\\"#x\\">link</a></body></html>".getBytes("UTF-8"));
      boolean ok = Updater.applyUpdate(dest, "2026-09-22.7", new Updater.Fetcher() {
        public byte[] get(String p) { return remote.get(p); }
      });
      System.out.print(ok + "," + new String(Files.readAllBytes(
        new File(dest, "index.html").toPath()), "UTF-8"));
    }`);
  assert.strictEqual(out, 'false,old');
});

test('android: a real script and real markup are accepted', () => {
  const out = updaterProbe(`
    public static void main(String[] a) throws Exception {
      System.out.print(Updater.looksLikeBuildFile("body{color:red}".getBytes("UTF-8"))
        + "," + Updater.looksLikeBuildFile("".getBytes("UTF-8"))
        + "," + Updater.versionIn("const APP_VERSION = '2026-09-22.7';\\n"));
    }`);
  assert.strictEqual(out, 'true,false,2026-09-22.7');
});