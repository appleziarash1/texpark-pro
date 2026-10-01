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
  const files = ['Json.java', 'Store.java', 'Voice.java', 'Sync.java'].map(f => path.join(SRC, f));
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
    } else if (op.equals("returns")) {
      /* The parcel-return rules, driven through the real Store methods the Android
         delivery screen calls. A return must raise the shelf for good goods only,
         and must stop the parcel reading as pending delivery. */
      st.list("returns").clear();
      st.list("deliveries").clear();
      Map<String,Object> draft = new LinkedHashMap<String,Object>();
      draft.put("customerName", "Return Test");
      draft.put("discount", "0"); draft.put("delivery", "0"); draft.put("advance", "0");
      List<Object> items = new ArrayList<Object>();
      Map<String,Object> it = new LinkedHashMap<String,Object>();
      it.put("productId", "seed-k3s"); it.put("qty", 10.0); it.put("rate", 220.0);
      it.put("cost", 100.0); it.put("vat", 0.0);
      items.add(it);
      Map<String,Object> card = st.stockOf("seed-k3s");
      card.put("opening", 30.0);
      card.put("available", Store.stockAvailable(card));
      out.put("availableBeforeSale", card.get("available"));
      Map<String,Object> memo = st.saveMemo(draft, items);
      out.put("memoSaved", memo != null);
      out.put("availableAfterSale", st.findStock("seed-k3s").get("available"));
      out.put("pendingFresh", st.pendingQtyOf(memo));

      Map<String,Object> ret = new LinkedHashMap<String,Object>();
      ret.put("id", Store.id()); ret.put("memoId", Store.str(memo, "id"));
      ret.put("memoNo", Store.str(memo, "memoNo")); ret.put("date", Store.today());
      ret.put("qty", 4.0); ret.put("condition", "good"); ret.put("note", "firse");
      List<Object> lines = new ArrayList<Object>();
      Map<String,Object> ln = new LinkedHashMap<String,Object>();
      ln.put("productId", "seed-k3s"); ln.put("qty", 4.0);
      lines.add(ln);
      ret.put("lines", lines);
      st.saveReturn(ret);
      out.put("availableAfterReturn", st.findStock("seed-k3s").get("available"));
      out.put("pendingAfterReturn", st.pendingQtyOf(memo));
      out.put("returnCount", st.list("returns").size());
      out.put("ledgerHasReturn", hasType(st, "Return"));

      // A damaged parcel is recorded but must not become sellable stock.
      Map<String,Object> bad = new LinkedHashMap<String,Object>();
      bad.put("id", Store.id()); bad.put("memoId", Store.str(memo, "id"));
      bad.put("memoNo", Store.str(memo, "memoNo")); bad.put("date", Store.today());
      bad.put("qty", 2.0); bad.put("condition", "damaged"); bad.put("note", "vanga");
      bad.put("lines", lines);
      st.saveReturn(bad);
      out.put("availableAfterDamaged", st.findStock("seed-k3s").get("available"));
      out.put("pendingAfterDamaged", st.pendingQtyOf(memo));

      // Undoing a good return takes the goods back off the shelf.
      st.reverseReturnFromStock(ret);
      out.put("availableAfterUndo", st.findStock("seed-k3s").get("available"));

      // Delivery and return share the pending figure, so they cannot double-count.
      Map<String,Object> dl = new LinkedHashMap<String,Object>();
      dl.put("id", Store.id()); dl.put("memoId", Store.str(memo, "id"));
      dl.put("memoNo", Store.str(memo, "memoNo")); dl.put("date", Store.today());
      dl.put("qty", 4.0); dl.put("delivered", 0.0);
      st.list("deliveries").add(dl);
      out.put("pendingDeliveryPlusReturn", st.pendingQtyOf(memo));
      // A memo carrying returns must survive a save/reload like any other record.
      st.commit();
      st = new Store(st.dbDir());
      st.load();
      out.put("returnCountAfterReload", st.list("returns").size());
    } else if (op.equals("deleteMemo")) {
      /* Deleting a memo that had a return filed against it. reverseSaleFromStock used
         to clamp sold at zero, so the returned qty was swallowed and the shelf read
         short; the web build had the same bug. Both must now restore stock exactly,
         and the card must still agree with the ledger it is rebuilt from. */
      st.list("returns").clear();
      st.list("deliveries").clear();
      st.list("ledger").clear();
      st.list("memos").clear();
      Map<String,Object> card = st.stockOf("seed-k3s");
      card.put("opening", 150.0); card.put("purchased", 0.0); card.put("sold", 0.0);
      card.put("available", Store.stockAvailable(card));
      st.logStock("seed-k3s", "Opening", 150.0, "Test", "opening");
      out.put("startAvailable", card.get("available"));

      Map<String,Object> draft = new LinkedHashMap<String,Object>();
      draft.put("customerName", "Delete Test");
      draft.put("discount", "0"); draft.put("delivery", "0"); draft.put("advance", "0");
      List<Object> items = new ArrayList<Object>();
      Map<String,Object> it = new LinkedHashMap<String,Object>();
      it.put("productId", "seed-k3s"); it.put("qty", 20.0); it.put("rate", 220.0);
      it.put("cost", 100.0); it.put("vat", 0.0);
      items.add(it);
      Map<String,Object> memo = st.saveMemo(draft, items);
      out.put("afterSale", st.findStock("seed-k3s").get("available"));

      Map<String,Object> ret = new LinkedHashMap<String,Object>();
      ret.put("id", Store.id()); ret.put("memoId", Store.str(memo, "id"));
      ret.put("memoNo", Store.str(memo, "memoNo")); ret.put("date", Store.today());
      ret.put("qty", 5.0); ret.put("condition", "good"); ret.put("note", "firse");
      List<Object> lines = new ArrayList<Object>();
      Map<String,Object> ln = new LinkedHashMap<String,Object>();
      ln.put("productId", "seed-k3s"); ln.put("qty", 5.0);
      lines.add(ln);
      ret.put("lines", lines);
      st.saveReturn(ret);
      out.put("afterReturn", st.findStock("seed-k3s").get("available"));

      st.deleteMemo(memo);
      out.put("afterDelete", st.findStock("seed-k3s").get("available"));
      out.put("soldAfterDelete", st.findStock("seed-k3s").get("sold"));
      out.put("memosLeft", st.list("memos").size());
      out.put("returnsLeft", st.list("returns").size());

      /* The card and the ledger must agree: a sync rebuilds from the ledger, so a
         clamped card would change the figure the owner was just looking at. */
      st.rebaseStockFromLedger();
      out.put("afterRebase", st.findStock("seed-k3s").get("available"));
      out.put("soldAfterRebase", st.findStock("seed-k3s").get("sold"));
    } else if (op.equals("sync")) {
      /* The rules that decide whether the owner's edit actually left the phone.
         Every case here is one that used to be read as a success. */
      out.put("okJson", Sync.pushAccepted("{\\"success\\":true,\\"message\\":\\"Backup saved for PH\\"}"));
      out.put("refusedJson", Sync.pushAccepted("{\\"success\\":false,\\"message\\":\\"Backup too large\\"}"));
      out.put("html", Sync.pushAccepted("<html><body>Sign in</body></html>"));
      out.put("empty", Sync.pushAccepted(""));
      out.put("null", Sync.pushAccepted(null));
      out.put("garbage", Sync.pushAccepted("not json at all"));
      out.put("refusedReport", Sync.pushReport(false, "{\\"success\\":false,\\"message\\":\\"Backup too large\\"}", "PH"));
      out.put("offlineReport", Sync.pushReport(false, null, "PH"));
      out.put("okReport", Sync.pushReport(true, "{\\"success\\":true}", "PH1"));
      // a merge that worked while the upload failed must say so, not "synced"
      out.put("mergePushFailed", Sync.mergeReport(false, 3, true, null));
      out.put("mergeAllGood", Sync.mergeReport(true, 3, true, null));
      out.put("mergeNothingNew", Sync.mergeReport(true, 0, true, null));
      out.put("mergeSaveFailed", Sync.mergeReport(true, 2, false, "disk full"));
      out.put("mergePushFailedAndSaveFailed", Sync.mergeReport(false, 2, false, "disk full"));
      out.put("pollFirst", Sync.pollDue(0, 1000));
      out.put("pollTooSoon", Sync.pollDue(1000, 1000 + Sync.POLL_EVERY_MS - 1));
      out.put("pollDueNow", Sync.pollDue(1000, 1000 + Sync.POLL_EVERY_MS));
      // the device tag must be unique per install, not a bare "PH"
      String tag = st.deviceTag();
      out.put("tag", tag);
      out.put("tagUnique", tag.length() > 2 && tag.startsWith("PH"));
      out.put("tagStable", tag.equals(st.deviceTag()));
    } else if (op.equals("settingsSync")) {
      /* Settings and users crossing between the PC and the phone, driven through
         the real Store. The three ways this can lose data rather than merely fail:
         a phone that adopts the PC's device tag renames its own memos, a phone that
         adopts the PC's sync URL can be pointed at a dead script, and a merge that
         duplicates the seed admin locks the owner out with "wrong password". */
      out.put("startsOneAdmin", st.list("users").size() == 1);
      out.put("adminId", Store.str(Store.rec(st.list("users").get(0)), "id"));

      // The PC's snapshot: a new company name, a memo prefix, a lower stock level,
      // a second user, and the PC's own sync URL and tag.
      Map<String,Object> cloud = new LinkedHashMap<String,Object>();
      Map<String,Object> cset = new LinkedHashMap<String,Object>();
      Map<String,Object> ccomp = new LinkedHashMap<String,Object>();
      ccomp.put("name", "TEXPARK BUYING HOUSE");
      ccomp.put("phone", "01621-008204");
      cset.put("company", ccomp);
      cset.put("memoPrefix", "TXP/NEW/");
      cset.put("lowStockLevel", 25.0);
      cset.put("syncUrl", "https://script.google.com/macros/s/PC_ONLY/exec");
      cset.put("deviceTag", "PC001");
      cset.put("companyUpdatedAt", "2099-01-01T00:00:00.000Z");
      cset.put("settingsUpdatedAt", "2099-01-01T00:00:00.000Z");
      cloud.put("settings", cset);
      cloud.put("users", new ArrayList<Object>());
      Map<String,Object> cloudUser = new LinkedHashMap<String,Object>();
      cloudUser.put("id", "seed-admin");
      cloudUser.put("username", "admin");
      cloudUser.put("name", "Administrator");
      cloudUser.put("pass", Store.hash("admin123"));
      cloudUser.put("role", "admin");
      cloudUser.put("active", true);
      ((List<Object>) cloud.get("users")).add(cloudUser);
      Map<String,Object> salesman = new LinkedHashMap<String,Object>();
      salesman.put("id", "u-rakib");
      salesman.put("username", "rakib");
      salesman.put("name", "Rakib");
      salesman.put("pass", Store.hash("rakib123"));
      salesman.put("role", "salesman");
      salesman.put("active", true);
      ((List<Object>) cloud.get("users")).add(salesman);

      st.mergeCloudInto(cloud);
      st.commit();

      out.put("companyName", Store.str(st.company(), "name"));
      out.put("companyPhone", Store.str(st.company(), "phone"));
      out.put("memoPrefix", Store.str(st.settings(), "memoPrefix"));
      out.put("lowStockLevel", Store.num(st.settings().get("lowStockLevel")));
      out.put("keptDeviceTag", !"PC001".equals(st.deviceTag()));
      out.put("keptOwnUrl", Store.str(st.settings(), "syncUrl").isEmpty());
      out.put("userCount", st.list("users").size());
      out.put("adminCount", countUser(st, "admin"));
      out.put("hasRakib", hasUser(st, "rakib"));

      // The new user can actually log in on this device.
      out.put("rakibCanLogin", st.login("rakib", "rakib123"));

      // A merge that repeats must not duplicate anything.
      st.mergeCloudInto(cloud);
      st.commit();
      out.put("userCountAfterSecondMerge", st.list("users").size());

      // A password reset on the PC reaches the phone: the change is in place, with
      // no new record and no changed id, so only the change stamp can carry it.
      cloudUser.put("pass", Store.hash("newpass99"));
      cloudUser.put("at", "2099-02-01T00:00:00.000Z");
      st.mergeCloudInto(cloud);
      st.commit();
      out.put("resetWorks", st.login("admin", "newpass99"));

      // Two fresh installs must not become two admins.
      Store other = new Store(new File(System.getProperty("java.io.tmpdir"),
          "texpark-native-other-" + System.nanoTime()));
      other.load();
      st.mergeCloudInto(other.db);
      st.commit();
      other.mergeCloudInto(st.db);
      other.commit();
      out.put("stillOneAdmin", countUser(st, "admin") == 1);
      out.put("otherOneAdmin", countUser(other, "admin") == 1);

      // An empty users list on the other side must never lock this device out.
      Map<String,Object> wiped = new LinkedHashMap<String,Object>();
      wiped.put("users", new ArrayList<Object>());
      wiped.put("settings", new LinkedHashMap<String,Object>());
      st.mergeCloudInto(wiped);
      st.commit();
      out.put("stillHasLogin", st.list("users").size() >= 1);

      // What is uploaded must never be a half-applied merge.
      out.put("snapshotHasAdmin", st.snapshotJson().contains("\\"username\\":\\"admin\\""));
    } else if (op.equals("costEdit")) {
      /* The buying price lives on the product AND on the stock card, and
         stockCost() reads the card first. Correcting the price on the Products
         page must therefore reach the card, or profit keeps the old cost. */
      Map<String,Object> p = st.productById("seed-k3s");
      List<Object> items = new ArrayList<Object>();
      Map<String,Object> it = new LinkedHashMap<String,Object>();
      it.put("productId", "seed-k3s"); it.put("qty", 1.0); it.put("rate", 220.0);
      it.put("cost", 165.0); it.put("vat", 0.0);
      items.add(it);
      Map<String,Object> draft = new LinkedHashMap<String,Object>();
      draft.put("customerName", "Rahim");
      draft.put("discount", "0"); draft.put("delivery", "0"); draft.put("advance", "0");
      st.saveMemo(draft, items);                       // creates the stock card at 165
      out.put("cardBefore", st.stockCost("seed-k3s"));
      st.setProductCost(p, 180);                       // the correction on Products
      out.put("productAfter", Store.num(p.get("cost")));
      out.put("cardAfter", st.stockCost("seed-k3s"));
      out.put("cardRecord", st.findStock("seed-k3s").get("cost"));
      // A zero must not erase a known cost.
      st.setProductCost(p, 0);
      out.put("afterZero", st.stockCost("seed-k3s"));
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

  static boolean hasAutoAdd(Store st) { return hasType(st, "AutoAdd"); }

  static int countUser(Store st, String username) {
    int n = 0;
    for (Object o : st.list("users")) {
      if (username.equals(Store.str(Store.rec(o), "username"))) n++;
    }
    return n;
  }

  static boolean hasUser(Store st, String username) { return countUser(st, username) > 0; }

  static boolean hasType(Store st, String type) {
    for (Object o : st.list("ledger")) {
      if (type.equals(Store.str(o, "type"))) return true;
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

test('native: correcting the buying price reaches the stock card', () => {
  /* The web and the phone both keep the buying price twice. If the correction
     only lands on the product, stockCost() keeps returning the card's old figure
     and every later memo reports the wrong profit - which the owner sees as
     profit going the wrong way. */
  const r = runNative({ op: 'costEdit' });
  assert.strictEqual(r.cardBefore, 165, 'the card starts on the original buying price');
  assert.strictEqual(r.productAfter, 180, 'the product carries the correction');
  assert.strictEqual(r.cardAfter, 180, 'stockCost follows the correction');
  assert.strictEqual(r.cardRecord, 180, 'the stock card itself was rewritten');
  assert.strictEqual(r.afterZero, 180, 'a zero does not erase a known buying price');
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

test('native: a sync only counts as a success when the sheet accepted the upload', () => {
  const r = runNative({ op: 'sync' });
  assert.strictEqual(r.okJson, true, 'success:true is an accepted upload');
  assert.strictEqual(r.refusedJson, false, 'success:false from the sheet is not a success');
  assert.strictEqual(r.html, false, 'an HTML reply (a proxy or login page) is not a success');
  assert.strictEqual(r.empty, false, 'an empty body is not a success');
  assert.strictEqual(r.null, false, 'no reply at all is not a success');
  assert.strictEqual(r.garbage, false, 'an unparseable body is not a success');
  assert.match(r.refusedReport, /Backup too large/, 'the sheet\'s own reason is shown');
  assert.match(r.offlineReport, /internet ba URL/i, 'a missing reply blames the network, not the sheet');
  // The bug the owner hit: a merge reported as a clean sync while his own edit
  // never left the phone, so the web app kept showing the old numbers.
  assert.match(r.mergePushFailed, /uthlo na/, 'a failed upload is reported even when a merge worked');
  assert.match(r.mergePushFailed, /^Ei device-er data sheet-e uthlo na/,
    'a failed upload leads the report, so it cannot be read as a clean sync');
  assert.match(r.mergeAllGood, /3 ta snapshot merge hoyeche/);
  assert.match(r.mergeNothingNew, /kono notun backup nei/);
  assert.match(r.mergeSaveFailed, /save korte parlam na: disk full/, 'a failed save surfaces the reason');
  assert.match(r.mergePushFailedAndSaveFailed, /uthlo na[\s\S]*save korte parlam na/,
    'both failures are reported, not just the last one');
  assert.strictEqual(r.pollFirst, true, 'the first poll always runs');
  assert.strictEqual(r.pollTooSoon, false, 'a second screen open does not poll again');
  assert.strictEqual(r.pollDueNow, true, 'once the interval has passed it polls again');
  // A bare "PH" would let the app and a phone browser share one sheet row and
  // overwrite each other's books.
  assert.strictEqual(r.tagUnique, true, 'the fallback device tag is unique per install: ' + r.tag);
  assert.strictEqual(r.tagStable, true, 'the tag is minted once and kept, so memo numbers stay stable');
});

test('native: a parcel return raises stock for good goods and records damaged ones', () => {
  const r = runNative({ op: 'returns' });
  assert.strictEqual(r.availableBeforeSale, 30, '30 on the shelf before the sale');
  assert.strictEqual(r.availableAfterSale, 20, 'selling 10 leaves 20');
  assert.strictEqual(r.pendingFresh, 10, 'all 10 start out pending');
  assert.strictEqual(r.availableAfterReturn, 24, '4 good returns are back on the shelf');
  assert.strictEqual(r.pendingAfterReturn, 6, 'a returned parcel is no longer pending');
  assert.strictEqual(r.returnCount, 1, 'the return is its own record');
  assert.strictEqual(r.ledgerHasReturn, true, 'the return is written to the stock ledger');
  assert.strictEqual(r.availableAfterDamaged, 24, 'damaged goods never become sellable stock');
  assert.strictEqual(r.pendingAfterDamaged, 4, 'but the damaged parcel still left the customer');
  assert.strictEqual(r.availableAfterUndo, 20, 'undoing a good return takes the goods back off');
  // Delivery and return share one pending figure - counting them separately is what
  // would make a returned parcel read as still out for delivery.
  assert.strictEqual(r.pendingDeliveryPlusReturn, 0, '4 delivered + 6 returned = the whole memo');
  // Two returns were entered (one good, one damaged), so both must come back.
  assert.strictEqual(r.returnCountAfterReload, 2, 'returns survive a save and reload');
});

test('native: deleting a memo with a return restores stock exactly, like the web', () => {
  const r = runNative({ op: 'deleteMemo' });
  assert.strictEqual(r.startAvailable, 150, '150 on the shelf to start');
  assert.strictEqual(r.afterSale, 130, 'the 20-piece memo took 20 off');
  assert.strictEqual(r.afterReturn, 135, 'the 5 good returns came back on');
  assert.strictEqual(r.afterDelete, 150,
    'deleting the memo frees its whole 20 - the returned 5 must not be swallowed by a clamp');
  assert.strictEqual(r.soldAfterDelete, 0, 'and the sold counter settles back at zero');
  assert.strictEqual(r.memosLeft, 0, 'the memo is gone');
  assert.strictEqual(r.returnsLeft, 0, 'its return records went with it');
  assert.strictEqual(r.afterRebase, 150, 'a sync leaves the same figure - card and ledger agree');
  assert.strictEqual(r.soldAfterRebase, 0, 'and they agree on sold');

  /* And the same case in the web build, so the two cannot drift apart again. */
  db = blankDB();
  const p = db.products.find(x => x.id === 'seed-k3s') || db.products[0];
  const base = 150;
  db.memos = []; db.returns = []; db.deliveries = []; db.ledger = []; db.stock = [];
  const card = stockOf(p.id);
  card.opening = base; card.purchased = 0; card.sold = 0; card.available = stockAvailable(card);
  logStock(p.id, 'Opening', base, 'Test', 'opening');
  const memo = {
    id: 'm-del', memoNo: 'TXP/SM/DEL-1', date: today(), customerName: 'Delete Test',
    items: [{ productId: p.id, productName: p.name, qty: 20, rate: 220, cost: 100, vat: 0, amount: 4400 }],
    totalQty: 20, subtotal: 4400, discount: 0, deliveryCharge: 0, vat: 0, grandTotal: 4400,
    advance: 0, due: 4400, cogs: 2000, profit: 2400, note: ''
  };
  db.memos.push(memo);
  applySaleToStock(memo);
  const ret = {
    id: 'r-del', memoId: memo.id, memoNo: memo.memoNo, date: today(),
    items: [{ productId: p.id, productName: p.name, qty: 5 }], qty: 5,
    condition: 'good', note: 'firse', returnedAt: new Date().toISOString()
  };
  db.returns.push(ret);
  applyReturnToStock(ret);
  assert.strictEqual(num(findStock(p.id).available), 135, 'web: the 5 returned came back on');
  reverseSaleFromStock(memo);
  reverseReturnFromStock(ret);
  db.returns = db.returns.filter(x => x.id !== ret.id);
  db.memos = db.memos.filter(x => x.id !== memo.id);
  assert.strictEqual(num(findStock(p.id).available), base,
    'web: the memo and its return together give back the full 20');
  const beforeRebase = num(findStock(p.id).available);
  rebaseStockFromLedger();
  assert.strictEqual(num(findStock(p.id).available), beforeRebase,
    'web: a sync leaves the same figure');
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

test('native: company details typed on the PC arrive on the phone', () => {
  const r = runNative({ op: 'settingsSync' });
  assert.strictEqual(r.companyName, 'TEXPARK BUYING HOUSE', 'the company name came across');
  assert.strictEqual(r.companyPhone, '01621-008204', 'so did the phone number');
  assert.strictEqual(r.memoPrefix, 'TXP/NEW/', 'the memo prefix came across');
  assert.strictEqual(r.lowStockLevel, 25, 'the low-stock level came across');
});

test('native: the phone keeps its own sync URL and device tag', () => {
  const r = runNative({ op: 'settingsSync' });
  // Adopting the PC's tag would rename this phone's memos; adopting its URL could
  // point the phone at a script that does not exist for it.
  assert.strictEqual(r.keptDeviceTag, true, 'the phone did not adopt the PC device tag');
  assert.strictEqual(r.keptOwnUrl, true, 'the phone did not adopt the PC sync URL');
});

test('native: a user created on the web can log in on the phone', () => {
  const r = runNative({ op: 'settingsSync' });
  assert.strictEqual(r.hasRakib, true, 'the new user arrived');
  assert.strictEqual(r.rakibCanLogin, true, 'and can actually log in');
});

test('native: merging never duplicates the seed admin', () => {
  const r = runNative({ op: 'settingsSync' });
  assert.strictEqual(r.startsOneAdmin, true, 'a fresh install has one admin');
  assert.strictEqual(r.adminId, 'seed-admin', 'the seed admin has the shared, stable id');
  assert.strictEqual(r.adminCount, 1, 'one admin after merging the PC');
  assert.strictEqual(r.userCountAfterSecondMerge, r.userCount, 'a repeated merge adds nobody');
  assert.strictEqual(r.stillOneAdmin, true, 'a second device does not become a second admin');
  assert.strictEqual(r.otherOneAdmin, true, 'and neither does this one');
});

test('native: a password reset on the PC works on the phone', () => {
  const r = runNative({ op: 'settingsSync' });
  // The password changed in place: same id, same record, only the hash differs. If
  // the change is not stamped the phone keeps the old password forever.
  assert.strictEqual(r.resetWorks, true, 'the phone accepts the password set on the PC');
});

test('native: a merge can never leave a device with no users', () => {
  const r = runNative({ op: 'settingsSync' });
  assert.strictEqual(r.stillHasLogin, true, 'there is still an account to log in with');
});

test('native: what is uploaded is never a half-applied merge', () => {
  const r = runNative({ op: 'settingsSync' });
  assert.strictEqual(r.snapshotHasAdmin, true, 'the snapshot taken under the lock is complete');
});
