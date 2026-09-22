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
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'android-src', 'com', 'texpark', 'pro', 'SiteUrl.java');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'siteurl-'));

function compile() {
  if (!fs.existsSync(SRC)) throw new Error('missing ' + SRC);
  const javac = process.env.JAVAC || 'javac';
  execFileSync(javac, ['-nowarn', '-d', OUT, SRC], { stdio: 'pipe' });
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
  execFileSync('javac', ['-nowarn', '-cp', OUT, '-d', OUT, p], { stdio: 'pipe' });
  return execFileSync('java', ['-cp', OUT, 'Probe', input], { encoding: 'utf8' });
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
  execFileSync('javac', ['-nowarn', '-cp', OUT, '-d', OUT, p], { stdio: 'pipe' });
  const out = execFileSync('java', ['-cp', OUT, 'NullProbe'], { encoding: 'utf8' });
  assert.strictEqual(out, '<<null>>');
});