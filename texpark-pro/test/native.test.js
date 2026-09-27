/* Proves the NATIVE rules and the WEB rules agree.
 *
 * The web app's db.js is the definition of the business: it is what the owner has
 * been using, and a native app that quietly disagreed with it would put wrong due
 * figures in front of him. So both implementations are fed the same cases here and
 * every figure must match exactly.
 *
 * Run: node test/native.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'android-src', 'com', 'texpark', 'pro');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'native-'));
const JAVAC = process.env.JAVAC || 'javac';
const JAVA = process.env.JAVA || (process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java');

/* ---- the real web rules, loaded unchanged, as logic.test.js does ---- */
const fakeStore = {};
global.localStorage = {
  getItem: k => (k in fakeStore ? fakeStore[k] : null),
  setItem: (k, v) => { fakeStore[k] = String(v); },
  removeItem: k => { delete fakeStore[k]; }
};
global.alert = () => {};
global.document = { getElementById: () => null };
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'texpark-pro', 'js', 'db.js'), 'utf8'),
  { filename: 'db.js' });

/* ---- the native rules, compiled and driven over stdin/stdout ---- */
function compileNative() {
  const files = ['Json.java', 'Store.java', 'Voice.java'].map(f => path.join(SRC, f));
  try {
    execFileSync(JAVAC, ['-source', '8', '-target', '8', '-nowarn', '-d', OUT].concat(files),
      { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('javac not found (' + JAVAC + '). Install a JDK or point JAVAC at one.');
    }
    throw new Error('native sources failed to compile:\n' + (e.stderr || e.stdout || e.message));
  }
}

/* A tiny driver is compiled alongside, so the test calls the real Store methods
   rather than re-implementing any rule in JavaScript. */
const DRIVER = `
import com.texpark.pro.*;
import java.io.*;
import java.util.*;

public class Driver {
  public static void main(String[] a) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    StringBuilder sb = new StringBuilder();
    String line;
    while ((line = in.readLine()) != null) sb.append(line).append('\\n');
    Map<String,Object> req = Json.obj(Json.read(sb.toString()));
    String op = String.valueOf(req.get("op"));
    Store st = new Store(new File(System.getProperty("java.io.tmpdir"), "texpark-native-" + System.nanoTime()));
    st.load();
    Map<String,Object> out = new LinkedHashMap<String,Object>();
    if (op.equals("rules")) {
      Map<String,Object> p1 = st.productById("seed-k3s");
      Map<String,Object> card = st.ensureStockCard("seed-k3s");
      out.put("cardExists", card != null);
      card.put("sold", 60.0);
      out.put("availableAtSixtySold", Store.stockAvailable(card));
      out.put("shortAtSixtySold", Store.stockShort(card));
      card.put("sold", 0.0);
      out.put("availableFresh", Store.stockAvailable(card));
      // a memo for 5 when the shelf is empty must still be recordable
      List<Object> items = new ArrayList<Object>();
      Map<String,Object> it = new LinkedHashMap<String,Object>();
      it.put("productId", "seed-k3s"); it.put("qty", 5.0); it.put("rate", 220.0);
      it.put("cost", 165.0); it.put("vat", 0.0);
      items.add(it);
      List<Map<String,Object>> probs = st.checkStockForItems(items, 0);
      out.put("shortReported", probs.size() == 1 ? probs.get(0).get("short") : -1);
      Map<String,Object> math = Store.memoMath(items, 0, 50, 100);
      out.put("grandTotal", math.get("grandTotal"));
      out.put("due", math.get("due"));
      out.put("profit", math.get("profit"));
      out.put("cogs", math.get("cogs"));
      // purchase at a new price: weighted average must move, not jump
      Map<String,Object> pu = new LinkedHashMap<String,Object>();
      List<Object> pitems = new ArrayList<Object>();
      Map<String,Object> pi = new LinkedHashMap<String,Object>();
      pi.put("productId", "seed-k3s"); pi.put("qty", 100.0); pi.put("cost", 200.0);
      pitems.add(pi);
      pu.put("items", pitems); pu.put("purchaseNo", "TXP/PO/T-001"); pu.put("supplierName", "S");
      st.applyPurchaseToStock(pu);
      Map<String,Object> card2 = st.findStock("seed-k3s");
      out.put("purchased", card2.get("purchased"));
      out.put("availableAfterPurchase", card2.get("available"));
      out.put("weightedCost", card2.get("cost"));
      // a sale of 30 of the 100 bought
      List<Object> sitems = new ArrayList<Object>();
      Map<String,Object> si = new LinkedHashMap<String,Object>();
      si.put("productId", "seed-k3s"); si.put("qty", 30.0); si.put("cost", card2.get("cost"));
      si.put("rate", 220.0); si.put("vat", 0.0);
      sitems.add(si);
      Map<String,Object> memo = new LinkedHashMap<String,Object>();
      memo.put("items", sitems); memo.put("memoNo", "TXP/SM/T-001"); memo.put("customerName", "C");
      st.applySaleToStock(memo);
      out.put("availableAfterSale", st.findStock("seed-k3s").get("available"));
      // P&L over everything so far
      Map<String,Object> memoRec = new LinkedHashMap<String,Object>(memo);
      memoRec.put("date", Store.today());
      memoRec.put("subtotal", 6600.0); memoRec.put("discount", 0.0);
      memoRec.put("deliveryCharge", 0.0); memoRec.put("vat", 0.0);
      memoRec.put("cogs", Store.round2(30 * Store.num(card2.get("cost"))));
      memoRec.put("profit", Store.round2(6600 - 30 * Store.num(card2.get("cost"))));
      memoRec.put("due", 0.0); memoRec.put("grandTotal", 6600.0); memoRec.put("advance", 6600.0);
      st.list("memos").add(memoRec);
      Map<String,Object> e = new LinkedHashMap<String,Object>();
      e.put("date", Store.today()); e.put("head", "Rent"); e.put("amount", 500.0);
      st.list("expenses").add(e);
      Map<String,Object> pl = st.plSummary("", "");
      out.put("plSales", pl.get("sales"));
      out.put("plGross", pl.get("grossProfit"));
      out.put("plNet", pl.get("netProfit"));
      out.put("receivable", st.totalReceivable());
      out.put("stockValue", st.stockValue());
      // memo numbering must be prefixed and per-device
      out.put("memoNo", st.nextMemoNo());
      // BUG GUARD: a memo whose stock was never entered must still add its stock
      // card, so the product appears on the Stock page.
      out.put("ledgerHasAutoAdd", hasAutoAdd(st));
    } else if (op.equals("login")) {
      out.put("good", st.login("admin", "admin123"));
      out.put("bad", st.login("admin", "wrong"));
      out.put("adminCanMemo", st.can("memo"));
      out.put("adminCanUsers", st.can("users"));
    } else if (op.equals("voice")) {
      // Every case is read by the real Voice class against the real seed products.
      for (String[] c : new String[][] {
          {"Kids 3pcs 5 piece ashlo", "seed-k3s", "5", "RECEIPT"},
          {"Kids 3pcs bikri 3 pcs", "seed-k3s", "3", "SALE"},
          {"KGS 10 ashlo", "seed-kgs", "10", "RECEIPT"},
          {"BK gelo 2", "seed-bk", "2", "SALE"},
          {"Kids Girls Sweater 7 bikri", "seed-kgs", "7", "SALE"},
          {"Kids 3pcs ashlo", "seed-k3s", "1", "RECEIPT"},
          {"Kids 3pcs 5", "seed-k3s", "5", "UNKNOWN"},
          {"aj rat e bhat khelam", null, "0", "UNKNOWN"},
          {"Kids 3pcs bikri", "seed-k3s", "0", "SALE"}
      }) {
        Voice.Reading r = Voice.read(st, c[0]);
        String pid = r.product == null ? null : Store.str(r.product, "id");
        out.put(c[0], (pid == null ? "null" : pid) + "|" + nums(r.qty) + "|" + r.intent);
      }
      // Bangla digits, which a bn-BD phone relays as often as ASCII ones.
      out.put("bnDigits", Voice.firstNumber("\u09E8\u09EB piece"));
      out.put("bnReceipt", Voice.read(st, "\u0995\u09BF\u09A1\u09B8 \u09E9 \u09AA\u09BF\u09B8 \u0986\u09B8\u09B2\u09CB").intent.toString());
    } else if (op.equals("memoSave")) {
      /* The shop's most important rule: a memo must never be refused because the
         stock number is low or absent. This drives Store.saveMemo itself, which is
         the method the app's memo screen calls. */
      Map<String,Object> draft = new LinkedHashMap<String,Object>();
      draft.put("customerName", "Rahim");
      draft.put("discount", "0"); draft.put("delivery", "0"); draft.put("advance", "0");
      List<Object> items = new ArrayList<Object>();
      Map<String,Object> it = new LinkedHashMap<String,Object>();
      it.put("productId", "seed-k3s"); it.put("qty", 25.0); it.put("rate", 220.0);
      it.put("cost", 165.0); it.put("vat", 0.0);
      items.add(it);

      // Nothing has been received: no stock card exists yet.
      out.put("cardBefore", st.findStock("seed-k3s") != null);
      Map<String,Object> saved = st.saveMemo(draft, items);
      out.put("saved", saved != null);
      out.put("memoCount", st.list("memos").size());
      out.put("grandTotal", saved == null ? null : saved.get("grandTotal"));
      // The card appeared and recorded the whole 25 as an unmet need.
      Map<String,Object> card = st.findStock("seed-k3s");
      out.put("cardAfter", card != null);
      out.put("sold", card == null ? null : card.get("sold"));
      out.put("available", card == null ? null : card.get("available"));
      out.put("short", card == null ? null : Store.stockShort(card));
      List<Map<String,Object>> probs = st.checkStockForItems(items, 0);
      out.put("shortReported", probs.isEmpty() ? -1 : probs.get(0).get("short"));
      // The customer was created from the memo, with no separate step.
      st.ensureCustomerFrom(saved);   // returns void; it creates the customer as a side effect
      boolean named = false;
      for (Object c : st.list("customers")) {
        if ("Rahim".equals(Store.str(Store.rec(c), "name"))) named = true;
      }
      out.put("customerNamedRahim", named);
      // An empty memo is refused - not because of stock, but because it says nothing.
      out.put("emptyRefused", st.saveMemo(draft, new ArrayList<Object>()) == null);
      // And it survives a reload, so the memo is really on disk.
      st = new Store(st.dbDir());
      st.load();
      out.put("memoCountAfterReload", st.list("memos").size());
    } else if (op.equals("json")) {
      // numbers must survive a round trip without growing a decimal point
      Map<String,Object> d = new LinkedHashMap<String,Object>();
      d.put("i", 2400); d.put("f", 145.5); d.put("s", "Kids 3pcs \\u09AE\\u09BE\\u09B2");
      d.put("b", true); d.put("n", null);
      String written = Json.write(d);
      out.put("written", written);
      out.put("roundTripI", Json.obj(Json.read(written)).get("i") instanceof Long);
      out.put("roundTripF", Json.obj(Json.read(written)).get("f"));
      out.put("roundTripS", Json.obj(Json.read(written)).get("s"));
      out.put("roundTripB", Json.obj(Json.read(written)).get("b"));
    }
    System.out.println(Json.write(out));
  }

  /** The driver must not touch Ui, which imports android.* and cannot compile here. */
  static String nums(double n) {
    if (n == Math.rint(n)) return String.valueOf((long) n);
    return String.format(java.util.Locale.US, "%.2f", n);
  }

  static boolean hasAutoAdd(Store st) {
    for (Object o : st.list("ledger")) {
      if ("AutoAdd".equals(Store.str(o, "type"))) return true;
    }
    return false;
  }
}
`;

function runNative(req) {
  const driverFile = path.join(OUT, 'Driver.java');
  if (!fs.existsSync(driverFile)) fs.writeFileSync(driverFile, DRIVER);
  execFileSync(JAVAC, ['-nowarn', '-cp', OUT, '-d', OUT, driverFile], { stdio: 'pipe' });
  const stdout = execFileSync(JAVA, ['-cp', OUT, 'Driver'], {
    input: JSON.stringify(req), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

compileNative();

test('native: json keeps integers integral and Bangla intact', () => {
  const r = runNative({ op: 'json' });
  assert.strictEqual(r.written, '{"i":2400,"f":145.5,"s":"Kids 3pcs \u09AE\u09BE\u09B2","b":true,"n":null}');
  assert.strictEqual(r.roundTripI, true, '2400 must come back as an integer, not 2400.0');
  assert.strictEqual(r.roundTripF, 145.5);
  assert.strictEqual(r.roundTripS, 'Kids 3pcs \u09AE\u09BE\u09B2');
  assert.strictEqual(r.roundTripB, true);
});

test('native: admin/admin123 logs in and role gates match the web', () => {
  const r = runNative({ op: 'login' });
  assert.strictEqual(r.good, true);
  assert.strictEqual(r.bad, false);
  assert.strictEqual(r.adminCanMemo, true);
  assert.strictEqual(r.adminCanUsers, true);
});

test('native: selling with no stock is allowed, reported as a shortfall', () => {
  const r = runNative({ op: 'rules' });
  assert.strictEqual(r.cardExists, true, 'memo product must get a stock card');
  assert.strictEqual(r.ledgerHasAutoAdd, true, 'the auto card must be logged');
  assert.strictEqual(r.availableFresh, 0);
  assert.strictEqual(r.shortReported, 5, 'shortfall is 5, reported not blocked');
});

test('native: a memo on an empty card reads 0 on the shelf and 60 to enter', () => {
  const r = runNative({ op: 'rules' });
  assert.strictEqual(r.availableAtSixtySold, 0, 'available clamps at 0, never negative');
  assert.strictEqual(r.shortAtSixtySold, 60, 'the 60 sold is kept as a shortfall');
});

test('native: memo money maths matches the web', () => {
  const r = runNative({ op: 'rules' });
  // 5 x 220 = 1100, +50 delivery = 1150, -100 advance = 1050 due; profit 1150-825 cogs
  assert.strictEqual(r.grandTotal, 1150);
  assert.strictEqual(r.due, 1050);
  assert.strictEqual(r.cogs, 825);
  assert.strictEqual(r.profit, 325);
});

test('native: purchase uses weighted-average cost, not the latest price', () => {
  const r = runNative({ op: 'rules' });
  assert.strictEqual(r.purchased, 100);
  assert.strictEqual(r.availableAfterPurchase, 100);
  // bought 100 at 200 with no opening: cost is exactly 200
  assert.strictEqual(r.weightedCost, 200);
  assert.strictEqual(r.availableAfterSale, 70);
});

test('native: P&L subtracts expenses from gross profit', () => {
  const r = runNative({ op: 'rules' });
  assert.strictEqual(r.plSales, 6600);
  assert.strictEqual(r.plGross, 6600 - 30 * 200);
  assert.strictEqual(r.plNet, 6600 - 30 * 200 - 500);
});

test('native: voice reads a sale or a receipt against real products', () => {
  const r = runNative({ op: 'voice' });
  assert.strictEqual(r['Kids 3pcs 5 piece ashlo'], 'seed-k3s|5|RECEIPT');
  assert.strictEqual(r['Kids 3pcs bikri 3 pcs'], 'seed-k3s|3|SALE');
  assert.strictEqual(r['KGS 10 ashlo'], 'seed-kgs|10|RECEIPT');
  assert.strictEqual(r['BK gelo 2'], 'seed-bk|2|SALE');
  // The longer name must win over a name it contains.
  assert.strictEqual(r['Kids Girls Sweater 7 bikri'], 'seed-kgs|7|SALE');
  // "ashlo" with no number means one arrived.
  assert.strictEqual(r['Kids 3pcs ashlo'], 'seed-k3s|1|RECEIPT');
});

test('native: voice never guesses - no intent, no product, no quantity are all refused', () => {
  const r = runNative({ op: 'voice' });
  // A quantity with no ashlo/bikri is not an instruction.
  assert.strictEqual(r['Kids 3pcs 5'], 'seed-k3s|5|UNKNOWN');
  // Neither is a sentence that names nothing in the catalogue.
  assert.strictEqual(r['aj rat e bhat khelam'], 'null|0|UNKNOWN');
  // A sale with no quantity stays at zero, so it is refused rather than assumed
  // to be one: the owner has to say how many went out.
  assert.strictEqual(r['Kids 3pcs bikri'], 'seed-k3s|0|SALE');
});

test('native: voice folds Bangla digits, which a bn-BN phone sends', () => {
  const r = runNative({ op: 'voice' });
  assert.strictEqual(r.bnDigits, 25);
  assert.strictEqual(r.bnReceipt, 'RECEIPT');
});

test('native: a memo saves with no stock at all, and creates the card to fill in later', () => {
  const r = runNative({ op: 'memoSave' });
  assert.strictEqual(r.cardBefore, false, 'no card exists before the sale');
  assert.strictEqual(r.saved, true, 'the memo must save with nothing on the shelf');
  assert.strictEqual(r.memoCount, 1);
  assert.strictEqual(r.grandTotal, 25 * 220, '25 x 220, nothing blocked the arithmetic');
  assert.strictEqual(r.cardAfter, true, 'the memo product must appear in Stock');
  assert.strictEqual(r.sold, 25);
  assert.strictEqual(r.available, 0, 'available clamps at 0, it never goes negative');
  assert.strictEqual(r.short, 25, 'the whole 25 is recorded as a shortfall to fill later');
  assert.strictEqual(r.shortReported, 25, 'reported, not blocked');
});

test('native: a memo saves and survives a reload, and creates the customer', () => {
  const r = runNative({ op: 'memoSave' });
  assert.strictEqual(r.customerNamedRahim, true, 'the customer is created from the memo');
  assert.strictEqual(r.memoCountAfterReload, 1, 'the memo is really on disk, not just in memory');
  // Only an empty memo is refused - it says nothing, and that is not the stock rule.
  assert.strictEqual(r.emptyRefused, true);
});

/* Static checks. There is no emulator here (no /dev/kvm), so a screen that never
   got wired up cannot be caught by driving the app. These read the source instead,
   and both catch a real shipping defect rather than a style preference. */
const screensSrc = fs.readFileSync(path.join(SRC, 'Screens.java'), 'utf8');

test('native: every menu item opens a screen, not a blank page', () => {
  const ids = [...screensSrc.matchAll(/new NavItem\("([a-z]+)",/g)].map(m => m[1]);
  assert.ok(ids.length >= 18, 'expected the full menu, found ' + ids.length);
  const unhandled = ids.filter(id => id !== 'dashboard'
    && !screensSrc.includes('"' + id + '".equals(page)'));
  assert.deepStrictEqual(unhandled, [],
    'menu items with no screen: ' + unhandled.join(', ') + ' would open blank');
});

test('native: nothing depends on a WebView or window.print any more', () => {
  const java = fs.readdirSync(SRC).filter(f => f.endsWith('.java'))
    .map(f => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]);
  // Strip comments first: the code explains why the WebView was removed, and that
  // explanation must not be mistaken for the thing it warns about.
  const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  const offenders = java.filter(([f, src]) =>
    /import android\.webkit|WebViewClient|loadUrl\(|window\.print/.test(code(src)));
  assert.deepStrictEqual(offenders.map(x => x[0]), [],
    'a WebView or a print call is back; a memo would stop printing again');
});

test('native: memo numbers carry the device tag so PC and phone cannot collide', () => {
  const r = runNative({ op: 'rules' });
  assert.match(r.memoNo, /^TXP\/SM\/\d{4}\/\d{2}\/\d{2}-[A-Z0-9]{1,6}\d{3}$/);
});
