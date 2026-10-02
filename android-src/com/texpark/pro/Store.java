package com.texpark.pro;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * The whole database and every business rule, ported from the web app's db.js.
 *
 * This class deliberately has NO Android imports. Everything that decides money -
 * stock clamping, the weighted-average purchase cost, the memo totals, the P&L,
 * the merge that keeps PC and phone agreeing - is plain Java so it can be compiled
 * and run on a JVM in the tests. A UI bug is visible the moment you look at the
 * screen; a rule bug shows up months later as a wrong due figure, so the rules are
 * the part worth being able to test without an emulator.
 *
 * The one rule that must never regress: a memo saves even when stock was never
 * entered. Stock follows memos, never the reverse.
 */
public class Store {

    public static final String[] MERGE_KEYS = {
        "products", "suppliers", "customers", "stock", "ledger",
        "purchases", "expenses", "memos", "deliveries", "returns", "payments",
        "users"
    };
    private static final int TOMB_MAX = 4000;
    private static final int SNAP_COUNT = 8;

    /* Settings travel between machines, but not all of them. These describe the
       machine, not the business: the sync URL is how this device reaches the sheet
       and the device tag is which machine this is. Syncing either would make the
       phone adopt the PC's URL or rename the PC to the phone - the two ways a merge
       can make a device stop syncing altogether. autoPull is per-device on purpose:
       turning it off on the phone must not silence the PC. */
    public static final String[] LOCAL_SETTING_KEYS = {"syncUrl", "deviceTag", "autoPull"};

    /* ------------------------------------------------------------ state */

    /** The whole document. Nested maps/lists of String, Long, Double, Boolean. */
    public Map<String, Object> db = new LinkedHashMap<String, Object>();
    public Map<String, Object> session;          // {userId, username, name, role}
    private Map<String, Map<String, Map<String, Object>>> lastCommitted;  // record index as of the last commit
    /** Why the last commit failed, so a save that could not be written is not
     *  reported as saved. Null after a successful commit. */
    public String lastSaveError;
    private File dir;
    private String tagCache;
    private Listener listener;

    /** Guards db between the UI thread (saving a memo) and the sync thread (merging
     *  a pull). Without it a poll that landed mid-save could merge into the document
     *  while it was being stamped and written, and the memo the owner had just
     *  entered would go out to the sheet missing from the file. */
    public final Object lock = new Object();

    public interface Listener { void onDataChanged(); }

    /** Called after every save, so the screen can rebuild without the caller asking. */
    public void setListener(Listener l) { this.listener = l; }

    public Store(File dir) { this.dir = dir; }

    /** The app's private folder. Backup files are written here, not to shared storage:
     *  a shop's customer list should not land anywhere another app can read. */
    public File dbDir() { return dir; }

    private File dataFile() { return new File(dir, "texpark_pro_v2.json"); }
    private File snapFile() { return new File(dir, "texpark_snapshots.json"); }
    private File tagFile()  { return new File(dir, "device_tag.txt"); }

    /* ------------------------------------------------------------ load/save */

    public void load() {
        String text = readFile(dataFile());
        if (text == null || text.trim().isEmpty()) {
            db = blankDB();
        } else {
            Object parsed = Json.read(text);
            db = migrate(parsed instanceof Map ? cast(parsed) : null);
        }
        ensureUsers();
        lastCommitted = frozenIndex(db);
    }

    /** A fresh install always has a way in; a wiped users list must not lock the owner out. */
    private void ensureUsers() {
        if (list("users").isEmpty()) {
            db.put("users", defaultUsers());
            commit();
        }
    }

    /** The same guard without the write, for use in the middle of a merge: the caller
     *  commits once at the end, and a second write here would race it. */
    private void ensureUsersQuiet() {
        if (list("users").isEmpty()) db.put("users", defaultUsers());
    }

    /** The document as it should be sent to the sheet, under the same lock that
     *  guards writes: an upload must not serialise a half-applied merge. */
    public String snapshotJson() {
        synchronized (lock) {
            return Json.write(db);
        }
    }

    private String readFile(File f) {
        if (f == null || !f.isFile()) return null;
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] buf = new byte[(int) f.length()];
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            return new String(buf, 0, off, "UTF-8");
        } catch (IOException e) {
            return null;
        } finally {
            close(in);
        }
    }

    private void writeFile(File f, String text) throws IOException {
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(f);
            out.write(text.getBytes("UTF-8"));
            out.flush();
        } finally {
            close(out);
        }
    }

    private static void close(java.io.Closeable c) {
        if (c != null) try { c.close(); } catch (IOException ignored) { }
    }

    /**
     * The single write path: stamp what changed, keep a safety copy, write the file.
     * Nothing else may touch the data file, so the stamps the merge depends on are
     * always present in what goes to disk.
     */
    public boolean commit() {
        synchronized (lock) {
            return commitLocked();
        }
    }

    private boolean commitLocked() {
        try {
            // The app's private folder always exists on a real device, but a test or
            // a restore can point Store at a fresh path. Without this mkdir the
            // write threw, commit() returned false with no reason given, and the
            // memo the owner had just typed simply vanished. Create it first.
            if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
                lastSaveError = "data folder banano gelo na: " + dir;
                return false;
            }
            stampChanged(nowIso());
            snapshot();
            writeFile(dataFile(), Json.write(db));
            lastCommitted = frozenIndex(db);
            lastSaveError = null;
        } catch (Exception e) {
            lastSaveError = e.toString();
            return false;
        }
        if (listener != null) listener.onDataChanged();
        return true;
    }

    /* ------------------------------------------------------------ helpers */

    public static double num(Object v) {
        if (v == null) return 0;
        if (v instanceof Number) return ((Number) v).doubleValue();
        try { return Double.parseDouble(String.valueOf(v).trim()); }
        catch (Exception e) { return 0; }
    }

    public static double round2(Object v) { return Math.round(num(v) * 100.0) / 100.0; }

    public static String id() {
        String chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        StringBuilder sb = new StringBuilder();
        long seed = System.nanoTime() ^ (long) (Math.random() * 1e18);
        java.util.Random r = new java.util.Random(seed);
        for (int i = 0; i < 8; i++) sb.append(chars.charAt(r.nextInt(chars.length())));
        return sb.toString();
    }

    public static String today() { return fmt("yyyy-MM-dd", new Date()); }

    public static String nowIso() { return fmt("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", new Date()); }

    private static String fmt(String pattern, Date d) {
        SimpleDateFormat f = new SimpleDateFormat(pattern, Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(d);
    }

    public static String esc(Object s) {
        String t = s == null ? "" : String.valueOf(s);
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    /* Typed access into the document. Every one tolerates a missing or wrong-typed
       entry, because a half-written backup file must not crash the app. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> cast(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<String, Object>();
    }

    public Map<String, Object> map(String key) { return cast(db.get(key)); }

    @SuppressWarnings("unchecked")
    public List<Object> list(String key) {
        Object v = db.get(key);
        return v instanceof List ? (List<Object>) v : new ArrayList<Object>();
    }

    public void putList(String key, List<Object> v) { db.put(key, v); }

    public Map<String, Object> settings() { return map("settings"); }

    public Map<String, Object> company() { return cast(settings().get("company")); }

    public static Map<String, Object> rec(Object o) { return cast(o); }

    public static String str(Object o, String key) {
        Object v = cast(o).get(key);
        return v == null ? "" : String.valueOf(v);
    }

    /* ------------------------------------------------------------ schema */

    public static Map<String, Object> defaultSettings() {
        Map<String, Object> s = new LinkedHashMap<String, Object>();
        s.put("syncUrl", "");
        Map<String, Object> c = new LinkedHashMap<String, Object>();
        c.put("name", "TEXPARK BUYING HOUSE");
        c.put("tagline", "Buying House");
        c.put("md", "MAHMUDUL HASAN SOURAV");
        c.put("phone", "01621-008204 | 01854-373404 | 01551-029365");
        c.put("email", "texpark.international01@gmail.com");
        c.put("address", "House-12, Road-06, Sector-09, Uttara, Dhaka-1230");
        c.put("bin", "");
        c.put("vatReg", "");
        s.put("company", c);
        s.put("memoPrefix", "TXP/SM/");
        s.put("deviceTag", "");
        s.put("warnOnShortStock", Boolean.TRUE);
        s.put("lowStockLevel", Long.valueOf(10));
        s.put("vatPercent", Long.valueOf(0));
        s.put("autoBackup", Boolean.TRUE);
        s.put("autoPull", Boolean.TRUE);
        return s;
    }

    public static Map<String, Object> blankDB() {
        Map<String, Object> d = new LinkedHashMap<String, Object>();
        d.put("version", Long.valueOf(2));
        List<Object> products = new ArrayList<Object>();
        /* Stable ids, shared by every device. A random id per device meant two
           devices that had merely started up merged into six products under three
           names the first time they synced. */
        products.add(seedProduct("seed-k3s", "Kids 3pcs Set", "K3S", "Kids", 220, 165));
        products.add(seedProduct("seed-kgs", "Kids Girls Sweater", "KGS", "Kids", 145, 108));
        products.add(seedProduct("seed-bk", "Baby Keepers", "BK", "Baby", 55, 41));
        d.put("products", products);
        d.put("suppliers", new ArrayList<Object>());
        d.put("customers", new ArrayList<Object>());
        d.put("stock", new ArrayList<Object>());
        d.put("ledger", new ArrayList<Object>());
        d.put("purchases", new ArrayList<Object>());
        d.put("expenses", new ArrayList<Object>());
        d.put("memos", new ArrayList<Object>());
        d.put("deliveries", new ArrayList<Object>());
        d.put("returns", new ArrayList<Object>());
        d.put("payments", new ArrayList<Object>());
        d.put("tombstones", new ArrayList<Object>());
        d.put("users", defaultUsers());
        d.put("settings", defaultSettings());
        Map<String, Object> seq = new LinkedHashMap<String, Object>();
        seq.put("memo", Long.valueOf(1));
        seq.put("purchase", Long.valueOf(1));
        d.put("seq", seq);
        return d;
    }

    private static Map<String, Object> seedProduct(String id, String name, String sku,
                                                   String category, double rate, double cost) {
        Map<String, Object> p = new LinkedHashMap<String, Object>();
        p.put("id", id);
        p.put("name", name);
        p.put("sku", sku);
        p.put("category", category);
        p.put("unit", "pcs");
        p.put("rate", Double.valueOf(rate));
        p.put("cost", Double.valueOf(cost));
        p.put("vat", Long.valueOf(0));
        p.put("reorderLevel", Long.valueOf(10));
        return p;
    }

    /* ------------------------------------------------------------ users */

    /** djb2. This gates screens, it is not encryption - stated so nobody mistakes it. */
    public static String hash(String s) {
        long h = 5381;
        if (s == null) s = "";
        for (int i = 0; i < s.length(); i++) h = ((h << 5) + h + s.charAt(i)) & 0xFFFFFFFFL;
        return Long.toHexString(h);
    }

    /** The seed account uses a fixed id, shared by every device, for the same reason
     *  the seed products do: two machines that have merely started up must merge to
     *  one admin, not two. */
    public static List<Object> defaultUsers() {
        List<Object> u = new ArrayList<Object>();
        Map<String, Object> a = new LinkedHashMap<String, Object>();
        a.put("id", "seed-admin");
        a.put("username", "admin");
        a.put("name", "Administrator");
        a.put("pass", hash("admin123"));
        a.put("role", "admin");
        a.put("active", Boolean.TRUE);
        a.put("createdAt", nowIso());
        u.add(a);
        return u;
    }

    private static final Map<String, List<String>> PERMS = new HashMap<String, List<String>>();
    static {
        PERMS.put("admin", Arrays.asList("dashboard", "memo", "history", "purchase", "supplier",
            "products", "stock", "delivery", "customers", "ledger", "profit", "pl",
            "ledgerreport", "expense", "users", "settings", "backup"));
        PERMS.put("manager", Arrays.asList("dashboard", "memo", "history", "purchase", "supplier",
            "products", "stock", "delivery", "customers", "ledger", "profit", "pl",
            "ledgerreport", "expense", "backup"));
        PERMS.put("salesman", Arrays.asList("dashboard", "memo", "history", "products", "stock",
            "delivery", "customers", "ledger", "backup"));
        PERMS.put("accountant", Arrays.asList("dashboard", "history", "customers", "ledger",
            "profit", "pl", "ledgerreport", "expense", "supplier", "backup"));
    }

    public boolean can(String page) {
        if (session == null) return false;
        List<String> p = PERMS.get(str(session, "role"));
        return p != null && p.contains(page);
    }

    public boolean login(String username, String password) {
        for (Object o : list("users")) {
            Map<String, Object> u = rec(o);
            if (!Boolean.FALSE.equals(u.get("active"))
                    && str(u, "username").equals(String.valueOf(username))
                    && str(u, "pass").equals(hash(String.valueOf(password)))) {
                session = new LinkedHashMap<String, Object>();
                session.put("userId", str(u, "id"));
                session.put("username", str(u, "username"));
                session.put("name", str(u, "name"));
                session.put("role", str(u, "role"));
                return true;
            }
        }
        return false;
    }

    /* ------------------------------------------------------------ migration */

    public Map<String, Object> migrate(Map<String, Object> d) {
        Map<String, Object> base = blankDB();
        if (d == null) return base;
        d.put("version", Long.valueOf(2));
        for (String k : MERGE_KEYS) {
            if (!(d.get(k) instanceof List)) d.put(k, new ArrayList<Object>());
        }
        if (!(d.get("tombstones") instanceof List)) d.put("tombstones", new ArrayList<Object>());
        if (!(d.get("users") instanceof List) || ((List<?>) d.get("users")).isEmpty()) {
            d.put("users", defaultUsers());
        }

        Map<String, Object> s = defaultSettings();
        Map<String, Object> incoming = cast(d.get("settings"));
        for (Map.Entry<String, Object> e : incoming.entrySet()) s.put(e.getKey(), e.getValue());
        Map<String, Object> c = cast(defaultSettings().get("company"));
        for (Map.Entry<String, Object> e : cast(incoming.get("company")).entrySet()) c.put(e.getKey(), e.getValue());
        s.put("company", c);
        d.put("settings", s);

        Map<String, Object> seq = new LinkedHashMap<String, Object>();
        seq.put("memo", Long.valueOf(1));
        seq.put("purchase", Long.valueOf(1));
        for (Map.Entry<String, Object> e : cast(d.get("seq")).entrySet()) seq.put(e.getKey(), e.getValue());
        d.put("seq", seq);

        for (Object o : listOf(d, "products")) {
            Map<String, Object> p = rec(o);
            p.put("cost", Double.valueOf(num(p.get("cost"))));
            p.put("rate", Double.valueOf(num(p.get("rate"))));
            p.put("vat", Double.valueOf(num(p.get("vat"))));
            p.put("reorderLevel", Double.valueOf(num(p.get("reorderLevel"))));
            if (str(p, "unit").isEmpty()) p.put("unit", "pcs");
            if (str(p, "category").isEmpty()) p.put("category", "General");
        }
        for (Object o : listOf(d, "stock")) {
            Map<String, Object> st = rec(o);
            st.put("opening", Double.valueOf(num(st.get("opening"))));
            st.put("purchased", Double.valueOf(num(st.get("purchased"))));
            st.put("sold", Double.valueOf(num(st.get("sold"))));
            st.put("adjusted", Double.valueOf(num(st.get("adjusted"))));
            st.put("available", Double.valueOf(stockAvailable(st)));
            st.put("cost", Double.valueOf(num(st.get("cost"))));
        }
        for (Object o : listOf(d, "memos")) {
            Map<String, Object> m = rec(o);
            if (!(m.get("items") instanceof List)) m.put("items", new ArrayList<Object>());
            for (Object io : rec(m).get("items") instanceof List ? (List<?>) m.get("items") : new ArrayList<Object>()) {
                Map<String, Object> it = rec(io);
                it.put("qty", Double.valueOf(num(it.get("qty"))));
                it.put("rate", Double.valueOf(num(it.get("rate"))));
                it.put("cost", Double.valueOf(num(it.get("cost"))));
                it.put("amount", Double.valueOf(round2(num(it.get("qty")) * num(it.get("rate")))));
            }
            m.put("subtotal", Double.valueOf(num(m.get("subtotal"))));
            m.put("discount", Double.valueOf(num(m.get("discount"))));
            m.put("deliveryCharge", Double.valueOf(num(m.get("deliveryCharge"))));
            m.put("grandTotal", Double.valueOf(num(m.get("grandTotal"))));
            m.put("advance", Double.valueOf(num(m.get("advance"))));
            m.put("due", Double.valueOf(num(m.get("due"))));
            m.put("cogs", Double.valueOf(num(m.get("cogs"))));
            m.put("profit", Double.valueOf(num(m.get("profit"))));
        }
        for (Object o : listOf(d, "purchases")) {
            Map<String, Object> p = rec(o);
            if (!(p.get("items") instanceof List)) p.put("items", new ArrayList<Object>());
            p.put("subtotal", Double.valueOf(num(p.get("subtotal"))));
            p.put("paid", Double.valueOf(num(p.get("paid"))));
            p.put("due", Double.valueOf(num(p.get("due"))));
        }
        for (Object o : listOf(d, "expenses")) rec(o).put("amount", Double.valueOf(num(rec(o).get("amount"))));
        for (Object o : listOf(d, "payments")) rec(o).put("amount", Double.valueOf(num(rec(o).get("amount"))));

        adoptSeedIds(d);
        return d;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> listOf(Map<String, Object> d, String key) {
        Object v = d.get(key);
        return v instanceof List ? (List<Object>) v : new ArrayList<Object>();
    }

    /** The three starter products used to get a random id per device. Repoint an
     *  untouched seed row at the shared id; anything the owner edited is left alone,
     *  because guessing wrong moves a memo onto another product. */
    private static void adoptSeedIds(Map<String, Object> d) {
        Map<String, String> seedIds = new HashMap<String, String>();
        seedIds.put("K3S", "seed-k3s");
        seedIds.put("KGS", "seed-kgs");
        seedIds.put("BK", "seed-bk");
        Map<String, String> rename = new HashMap<String, String>();
        java.util.Set<String> taken = new java.util.HashSet<String>();
        for (Object o : listOf(d, "products")) taken.add(str(o, "id"));
        for (Object o : listOf(d, "products")) {
            Map<String, Object> p = rec(o);
            String sku = str(p, "sku");
            String shared = seedIds.get(sku);
            if (shared == null || taken.contains(shared)) continue;
            if (!str(p, "name").equals(seedName(sku))) continue;
            rename.put(str(p, "id"), shared);
            taken.add(shared);
        }
        if (rename.isEmpty()) return;
        for (Object o : listOf(d, "products")) {
            Map<String, Object> p = rec(o);
            String to = rename.get(str(p, "id"));
            if (to != null) p.put("id", to);
        }
        for (String key : MERGE_KEYS) {
            for (Object o : listOf(d, key)) {
                Map<String, Object> r = rec(o);
                String to = rename.get(str(r, "productId"));
                if (to != null) r.put("productId", to);
            }
        }
    }

    private static String seedName(String sku) {
        if ("K3S".equals(sku)) return "Kids 3pcs Set";
        if ("KGS".equals(sku)) return "Kids Girls Sweater";
        if ("BK".equals(sku)) return "Baby Keepers";
        return "";
    }

    /* ============================ stock engine ============================ */

    /** What the books say, before physical reality. This figure can go negative. */
    public static double stockRaw(Map<String, Object> s) {
        if (s == null) return 0;
        return num(s.get("opening")) + num(s.get("purchased")) - num(s.get("sold"));
    }

    /** What is physically on the shelf, so it stops at 0. A memo that went out before
     *  its stock was entered leaves the card at 0, not negative. */
    public static double stockAvailable(Map<String, Object> s) { return Math.max(0, stockRaw(s)); }

    /** Still to be entered: sales that went out minus what was ever received. */
    public static double stockShort(Map<String, Object> s) { return Math.max(0, -stockRaw(s)); }

    /** Read-only lookup - never creates a card, so reports cannot mask a fresh product. */
    public Map<String, Object> findStock(String productId) {
        for (Object o : list("stock")) if (str(o, "productId").equals(productId)) return rec(o);
        return null;
    }

    public Map<String, Object> stockOf(String productId) {
        Map<String, Object> s = findStock(productId);
        if (s == null) {
            s = new LinkedHashMap<String, Object>();
            s.put("id", id());
            s.put("productId", productId);
            s.put("opening", Long.valueOf(0));
            s.put("purchased", Long.valueOf(0));
            s.put("sold", Long.valueOf(0));
            s.put("cost", Long.valueOf(0));
            s.put("available", Long.valueOf(0));
            list("stock").add(s);
        }
        s.put("available", Double.valueOf(stockAvailable(s)));
        return s;
    }

    /** A product in a memo must also appear in the Stock book even when nobody has
     *  entered opening stock. The card is created at 0 received so the sale has
     *  somewhere to land, and the owner tops it up whenever it suits. */
    public Map<String, Object> ensureStockCard(String productId) {
        Map<String, Object> p = productById(productId);
        if (p == null) return null;
        boolean existed = findStock(productId) != null;
        Map<String, Object> s = stockOf(productId);
        if (!existed) {
            s.put("cost", Double.valueOf(num(p.get("cost"))));
            Map<String, Object> l = new LinkedHashMap<String, Object>();
            l.put("id", id());
            l.put("at", nowIso());
            l.put("date", today());
            l.put("productId", productId);
            l.put("type", "AutoAdd");
            l.put("qty", Long.valueOf(0));
            l.put("balance", Double.valueOf(stockAvailable(s)));
            l.put("ref", "Memo");
            l.put("note", "Stock card created from a sales memo - received qty ekhono deya hoy ni");
            list("ledger").add(l);
        }
        return s;
    }

    public Map<String, Object> productById(String pid) {
        for (Object o : list("products")) if (str(o, "id").equals(pid)) return rec(o);
        return null;
    }

    public Map<String, Object> memoById(String mid) {
        for (Object o : list("memos")) if (str(o, "id").equals(mid)) return rec(o);
        return null;
    }

    /** A memo typed with a new customer name creates that customer, so the name the
     *  owner just sold to is on the Customer list without a second trip to a form.
     *  A blank name is skipped: "(no name)" is not a customer. */
    public void ensureCustomerFrom(Map<String, Object> memo) {
        String name = str(memo, "customerName").trim();
        if (name.isEmpty()) return;
        for (Object o : list("customers")) {
            if (str(o, "name").equalsIgnoreCase(name)) {
                Map<String, Object> c = rec(o);
                if (str(c, "phone").isEmpty() && !str(memo, "customerPhone").isEmpty()) {
                    c.put("phone", str(memo, "customerPhone"));
                }
                memo.put("customerId", str(c, "id"));
                return;
            }
        }
        Map<String, Object> c = new LinkedHashMap<String, Object>();
        c.put("id", id());
        c.put("name", name);
        c.put("phone", str(memo, "customerPhone").trim());
        c.put("address", str(memo, "customerAddress").trim());
        list("customers").add(c);
        memo.put("customerId", str(c, "id"));
    }

    public double stockCost(String productId) {
        Map<String, Object> s = findStock(productId);
        Map<String, Object> p = productById(productId);
        double sc = s == null ? 0 : num(s.get("cost"));
        return sc != 0 ? sc : (p == null ? 0 : num(p.get("cost")));
    }

    /** Sets a product's buying price, and keeps the stock card's copy in step.
     *  stockCost() reads the card first, so a correction typed on the Products
     *  page used to be ignored by every later memo and profit kept the old cost. */
    public void setProductCost(Map<String, Object> p, double cost) {
        p.put("cost", Double.valueOf(cost));
        Map<String, Object> card = findStock(str(p, "id"));
        if (card != null && cost > 0) card.put("cost", Double.valueOf(cost));
    }

    /** Append-only movement log - every change stays traceable. */
    public void logStock(String productId, String type, double qty, String ref, String note) {
        Map<String, Object> l = new LinkedHashMap<String, Object>();
        l.put("id", id());
        l.put("at", nowIso());
        l.put("date", today());
        l.put("productId", productId);
        l.put("type", type);
        l.put("qty", Double.valueOf(num(qty)));
        Map<String, Object> s = findStock(productId);
        l.put("balance", Double.valueOf(s == null ? 0 : stockAvailable(s)));
        l.put("ref", ref == null ? "" : ref);
        l.put("note", note == null ? "" : note);
        list("ledger").add(l);
    }

    /** Report only. A short line never blocks a memo: the memo is the truth. */
    public List<Map<String, Object>> checkStockForItems(List<Object> items, double allowFor) {
        List<Map<String, Object>> problems = new ArrayList<Map<String, Object>>();
        Map<String, Double> need = new LinkedHashMap<String, Double>();
        for (Object io : items) {
            Map<String, Object> it = rec(io);
            String pid = str(it, "productId");
            Double prev = need.get(pid);
            need.put(pid, (prev == null ? 0 : prev) + num(it.get("qty")));
        }
        for (Map.Entry<String, Double> e : need.entrySet()) {
            Map<String, Object> p = productById(e.getKey());
            Map<String, Object> card = findStock(e.getKey());
            double avail = (card == null ? 0 : num(card.get("available"))) + allowFor;
            if (avail < e.getValue()) {
                Map<String, Object> pr = new LinkedHashMap<String, Object>();
                pr.put("productId", e.getKey());
                pr.put("name", p == null ? "(deleted product)" : str(p, "name"));
                pr.put("requested", Double.valueOf(e.getValue()));
                pr.put("available", Double.valueOf(avail));
                pr.put("short", Double.valueOf(e.getValue() - avail));
                problems.add(pr);
            }
        }
        return problems;
    }

    /**
     * Records a memo. This is the rule the whole app exists to honour.
     *
     * A memo is never refused for want of stock. The shop sells goods it has not
     * yet entered - the memo is what the customer takes away, and the stock card is
     * only the shop's own count of the shelf. Blocking a sale because the shelf
     * number is low would refuse a sale that is actually happening, so the memo is
     * written first and the shortfall is reported afterwards for the Stock page.
     *
     * A product used on a memo gets its stock card here even if none exists, so a
     * product the owner only ever sells still turns up on the Stock page and can be
     * filled in later. That is why the card list is not simply the product list.
     *
     * Returns the memo when it was saved, or null when the write failed. A failed
     * write leaves nothing half-applied: the stock and customer effects are undone.
     */
    public Map<String, Object> saveMemo(Map<String, Object> draft, List<Object> items) {
        if (items == null || items.isEmpty()) return null;
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", id());
        String no = str(draft, "memoNo");
        m.put("memoNo", no.isEmpty() ? consumeMemoNo() : no);
        String date = str(draft, "date");
        m.put("date", date.isEmpty() ? today() : date);
        m.put("customerId", str(draft, "customerId"));
        m.put("customerName", str(draft, "customerName"));
        m.put("customerPhone", str(draft, "customerPhone"));
        m.put("customerAddress", str(draft, "customerAddress"));
        m.put("items", items);
        Map<String, Object> money = memoMath(items, num(draft.get("discount")),
                num(draft.get("delivery")), num(draft.get("advance")));
        for (Map.Entry<String, Object> e : money.entrySet()) m.put(e.getKey(), e.getValue());
        m.put("note", str(draft, "note"));
        m.put("device", deviceTag());

        list("memos").add(m);
        ensureCustomerFrom(m);
        applySaleToStock(m);

        if (!commit()) {
            list("memos").remove(m);
            reverseSaleFromStock(m);
            return null;
        }
        return m;
    }

    /** Delete a memo and undo everything it did to stock. The returns and deliveries
     *  filed against it are real history, so they go with it - the web build does the
     *  same, and leaving them behind would keep stock held out for a memo that no
     *  longer exists. */
    public void deleteMemo(Map<String, Object> m) {
        reverseSaleFromStock(m);
        String mid = str(m, "id");
        List<Object> keepD = new ArrayList<Object>();
        for (Object o : list("deliveries")) {
            if (!mid.equals(str(rec(o), "memoId"))) keepD.add(o);
        }
        db.put("deliveries", keepD);
        List<Object> keepR = new ArrayList<Object>();
        for (Object o : list("returns")) {
            Map<String, Object> r = rec(o);
            if (mid.equals(str(r, "memoId"))) reverseReturnFromStock(r);
            else keepR.add(o);
        }
        db.put("returns", keepR);
        list("memos").remove(m);
        commit();
    }

    public void applySaleToStock(Map<String, Object> memo) {
        List<Object> items = memo.get("items") instanceof List ? listOf(memo, "items") : new ArrayList<Object>();
        for (Object io : items) {
            Map<String, Object> it = rec(io);
            String pid = str(it, "productId");
            Map<String, Object> s = stockOf(pid);
            s.put("sold", Double.valueOf(num(s.get("sold")) + num(it.get("qty"))));
            s.put("available", Double.valueOf(stockAvailable(s)));
            logStock(pid, "Sale", -num(it.get("qty")), str(memo, "memoNo"), str(memo, "customerName"));
        }
    }

    /** Undo a sale: the goods come back onto the shelf and the memo's qty leaves
     *  `sold`. No clamp on the way down. `sold` is a running counter, and reversing
     *  a memo that already had a return filed against it takes the full memo qty out
     *  here while the return's own entry adds its share back, so it dips below zero
     *  mid-transaction and the two net out. Clamping swallowed the difference - a
     *  memo of 20 with 5 returned left `sold` 5 too high. It also disagreed with
     *  rebaseStockFromLedger, which replays the same ledger without clamping, so the
     *  figure moved by itself after a sync. available is what the owner sees, and
     *  that is clamped in stockAvailable. */
    public void reverseSaleFromStock(Map<String, Object> memo) {
        List<Object> items = listOf(memo, "items");
        for (Object io : items) {
            Map<String, Object> it = rec(io);
            String pid = str(it, "productId");
            Map<String, Object> s = findStock(pid);
            if (s == null) continue;
            s.put("sold", Double.valueOf(num(s.get("sold")) - num(it.get("qty"))));
            s.put("available", Double.valueOf(stockAvailable(s)));
            logStock(pid, "SaleReturn", num(it.get("qty")), str(memo, "memoNo"), "Memo deleted");
        }
    }

    /* ------------------------- delivery / parcel return ------------------------- */

    public double deliveredQtyOf(String memoId) {
        double q = 0;
        for (Object o : list("deliveries")) {
            Map<String, Object> d = rec(o);
            if (str(d, "memoId").equals(memoId)) q += num(d.get("qty"));
        }
        return q;
    }

    public double returnedQtyOf(String memoId) {
        double q = 0;
        for (Object o : list("returns")) {
            Map<String, Object> r = rec(o);
            if (str(r, "memoId").equals(memoId)) q += num(r.get("qty"));
        }
        return q;
    }

    /** What is still with the customer: sold, minus what has gone out, minus what
     *  has come back. A return counts here, so a returned parcel stops reading as
     *  pending delivery the way it did before returns existed. */
    public double pendingQtyOf(Map<String, Object> memo) {
        if (memo == null) return 0;
        return Math.max(0, num(memo.get("totalQty"))
            - deliveredQtyOf(str(memo, "id")) - returnedQtyOf(str(memo, "id")));
    }

    /** Goods coming back onto the shelf. Damaged goods are recorded but not made
     *  sellable, so the stock figure stays truthful. */
    public void applyReturnToStock(Map<String, Object> ret) {
        if (!"good".equals(str(ret, "condition"))) return;
        for (Object io : listOf(ret, "lines")) {
            Map<String, Object> it = rec(io);
            double q = num(it.get("qty"));
            if (q <= 0) continue;
            String pid = str(it, "productId");
            Map<String, Object> s = stockOf(pid);
            /* No clamp, for the same reason as reverseSaleFromStock: the ledger
             *  replay subtracts the full return qty from `sold`. */
            s.put("sold", Double.valueOf(num(s.get("sold")) - q));
            s.put("available", Double.valueOf(stockAvailable(s)));
            logStock(pid, "Return", q, str(ret, "memoNo"), "Parcel return (" + str(ret, "condition") + ")");
        }
    }

    public void reverseReturnFromStock(Map<String, Object> ret) {
        if (!"good".equals(str(ret, "condition"))) return;
        for (Object io : listOf(ret, "lines")) {
            Map<String, Object> it = rec(io);
            double q = num(it.get("qty"));
            if (q <= 0) continue;
            String pid = str(it, "productId");
            Map<String, Object> s = findStock(pid);
            if (s == null) continue;
            s.put("sold", Double.valueOf(num(s.get("sold")) + q));
            s.put("available", Double.valueOf(stockAvailable(s)));
            logStock(pid, "ReturnUndo", -q, str(ret, "memoNo"), "Return deleted");
        }
    }

    /** Record a parcel coming back. Stock rises for good goods, and the record is
     *  kept even for damaged ones so the shop can show the customer what happened. */
    public Map<String, Object> saveReturn(Map<String, Object> ret) {
        applyReturnToStock(ret);
        list("returns").add(ret);
        return ret;
    }

    public void applyPurchaseToStock(Map<String, Object> purchase) {
        for (Object io : listOf(purchase, "items")) {
            Map<String, Object> it = rec(io);
            String pid = str(it, "productId");
            Map<String, Object> s = stockOf(pid);
            s.put("purchased", Double.valueOf(num(s.get("purchased")) + num(it.get("qty"))));
            /* Weighted-average cost, so profit stays honest as buying prices change. */
            double onHand = num(s.get("purchased")) + num(s.get("opening")) - num(s.get("sold"));
            double oldValue = num(s.get("cost")) * Math.max(0, onHand - num(it.get("qty")));
            double newValue = num(it.get("cost")) * num(it.get("qty"));
            s.put("cost", Double.valueOf(onHand > 0 ? round2((oldValue + newValue) / onHand) : num(it.get("cost"))));
            s.put("available", Double.valueOf(stockAvailable(s)));
            logStock(pid, "Purchase", num(it.get("qty")), str(purchase, "purchaseNo"), str(purchase, "supplierName"));
        }
    }

    /* ============================ money maths ============================ */

    /** Grand = Subtotal - Discount + Delivery + VAT. Due = Grand - Advance. */
    public static Map<String, Object> memoMath(List<Object> items, double discountIn,
                                               double deliveryIn, double advanceIn) {
        double subtotal = 0, cogs = 0, vat = 0, totalQty = 0;
        for (Object io : items) {
            Map<String, Object> it = rec(io);
            double qty = num(it.get("qty")), rate = num(it.get("rate"));
            double amount = round2(qty * rate);
            totalQty += qty;
            it.put("qty", Double.valueOf(qty));
            it.put("rate", Double.valueOf(rate));
            it.put("amount", Double.valueOf(amount));
            it.put("cost", Double.valueOf(num(it.get("cost"))));
            subtotal = round2(subtotal + amount);
            cogs = round2(cogs + round2(qty * num(it.get("cost"))));
            vat = round2(vat + round2(amount * num(it.get("vat")) / 100.0));
        }
        double discount = Math.min(Math.max(0, discountIn), subtotal);
        double delivery = Math.max(0, deliveryIn);
        double grand = round2(Math.max(0, subtotal - discount + delivery + vat));
        double advance = Math.min(Math.max(0, advanceIn), grand);
        double due = round2(grand - advance);
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        /* totalQty is what delivery and return are measured against, so it is part of
           the memo maths rather than something each screen adds up for itself. */
        m.put("totalQty", Double.valueOf(totalQty));
        m.put("subtotal", Double.valueOf(subtotal));
        m.put("discount", Double.valueOf(discount));
        m.put("deliveryCharge", Double.valueOf(delivery));
        m.put("vat", Double.valueOf(vat));
        m.put("grandTotal", Double.valueOf(grand));
        m.put("advance", Double.valueOf(advance));
        m.put("due", Double.valueOf(due));
        m.put("cogs", Double.valueOf(cogs));
        m.put("profit", Double.valueOf(round2(subtotal - discount + delivery - cogs)));
        return m;
    }

    /* ============================ profit & loss ============================ */

    private static boolean dateInRange(String d, String from, String to) {
        if (from != null && !from.isEmpty() && d.compareTo(from) < 0) return false;
        if (to != null && !to.isEmpty() && d.compareTo(to) > 0) return false;
        return true;
    }

    public Map<String, Object> plSummary(String from, String to) {
        double sales = 0, cogs = 0, discount = 0, deliveryIncome = 0, vatCollected = 0, grossProfit = 0;
        for (Object o : list("memos")) {
            Map<String, Object> m = rec(o);
            if (!dateInRange(str(m, "date"), from, to)) continue;
            sales = round2(sales + num(m.get("subtotal")));
            discount = round2(discount + num(m.get("discount")));
            deliveryIncome = round2(deliveryIncome + num(m.get("deliveryCharge")));
            vatCollected = round2(vatCollected + num(m.get("vat")));
            cogs = round2(cogs + num(m.get("cogs")));
            grossProfit = round2(grossProfit + num(m.get("profit")));
        }
        double expense = 0;
        for (Object o : list("expenses")) {
            Map<String, Object> e = rec(o);
            if (dateInRange(str(e, "date"), from, to)) expense = round2(expense + num(e.get("amount")));
        }
        Map<String, Object> r = new LinkedHashMap<String, Object>();
        r.put("sales", Double.valueOf(sales));
        r.put("discount", Double.valueOf(discount));
        r.put("cogs", Double.valueOf(cogs));
        r.put("grossProfit", Double.valueOf(grossProfit));
        r.put("deliveryIncome", Double.valueOf(deliveryIncome));
        r.put("vatCollected", Double.valueOf(vatCollected));
        r.put("expense", Double.valueOf(expense));
        r.put("netProfit", Double.valueOf(round2(grossProfit - expense)));
        return r;
    }

    public double totalReceivable() {
        double a = 0;
        for (Object o : list("memos")) a = round2(a + num(rec(o).get("due")));
        return a;
    }

    public double totalPayable() {
        double a = 0;
        for (Object o : list("purchases")) a = round2(a + num(rec(o).get("due")));
        return a;
    }

    public double stockValue() {
        double a = 0;
        for (Object o : list("products")) {
            Map<String, Object> p = rec(o);
            Map<String, Object> s = findStock(str(p, "id"));
            a = round2(a + (s == null ? 0 : num(s.get("available"))) * stockCost(str(p, "id")));
        }
        return a;
    }

    /* ==================== repairing old memos' cost ====================
     *  A memo freezes the buying price it was written with: the line stores cost,
     *  and cogs/profit are computed from it once and saved. That is right for a
     *  fresh memo - but memos written while stockCost() returned a stale figure
     *  (the buying-price bug) froze a wrong cost, and correcting the product today
     *  does not reach back into them.
     *
     *  The correct cost is the product's buying price *now*: the best available
     *  estimate, and what the owner means by "fix my old memos". A memo whose line
     *  already matches is left alone, so running this twice is a no-op.
     *  Java 7 source level: no lambdas, no diamond. */

    /** One item's corrected cost, or null when nothing should change. */
    private Double repairedCostForItem(Map<String, Object> it) {
        String pid = str(it, "productId");
        Map<String, Object> p = productById(pid);
        if (p == null) return null;                  // product deleted: price unknown
        double want = stockCost(pid);
        if (want == 0) want = num(p.get("cost"));
        if (!(want > 0)) return null;                // never rewrite against a missing price
        if (round2(want) == round2(num(it.get("cost")))) return null;
        return Double.valueOf(round2(want));
    }

    /** Every memo that would change, with its old and new figures. Reads only, so
     *  the preview and the apply pass always agree. */
    public List<Map<String, Object>> planMemoCostRepair() {
        List<Map<String, Object>> plan = new ArrayList<Map<String, Object>>();
        for (Object mo : list("memos")) {
            Map<String, Object> m = rec(mo);
            List<Object> items = Json.arr(m.get("items"));
            List<Map<String, Object>> changed = new ArrayList<Map<String, Object>>();
            List<Object> fixed = new ArrayList<Object>();
            for (Object io : items) {
                Map<String, Object> it = rec(io);
                Double want = repairedCostForItem(it);
                if (want == null) {
                    fixed.add(it);
                } else {
                    Map<String, Object> copy = new LinkedHashMap<String, Object>(it);
                    copy.put("cost", want);
                    fixed.add(copy);
                    Map<String, Object> row = new LinkedHashMap<String, Object>();
                    row.put("productName", str(it, "productName"));
                    row.put("qty", Double.valueOf(num(it.get("qty"))));
                    row.put("was", Double.valueOf(round2(num(it.get("cost")))));
                    row.put("now", want);
                    changed.add(row);
                }
            }
            if (changed.isEmpty()) continue;
            Map<String, Object> fin = memoMath(fixed, num(m.get("discount")),
                    num(m.get("deliveryCharge")), num(m.get("advance")));
            Map<String, Object> row = new LinkedHashMap<String, Object>();
            row.put("memoId", str(m, "id"));
            row.put("memoNo", str(m, "memoNo"));
            row.put("date", str(m, "date"));
            row.put("customerName", str(m, "customerName"));
            row.put("items", changed);
            row.put("wasCogs", Double.valueOf(round2(num(m.get("cogs")))));
            row.put("nowCogs", fin.get("cogs"));
            row.put("wasProfit", Double.valueOf(round2(num(m.get("profit")))));
            row.put("nowProfit", fin.get("profit"));
            plan.add(row);
        }
        return plan;
    }

    /** Apply the plan. The stock book is not touched: a memo's cost affects profit,
     *  not quantities, so available/sold stay exactly as they were. Returns how many
     *  memos changed. */
    public int applyMemoCostRepair() {
        List<Map<String, Object>> plan = planMemoCostRepair();
        for (Object po : plan) {
            Map<String, Object> row = rec(po);
            Map<String, Object> m = memoById(str(row, "memoId"));
            if (m == null) continue;
            List<Object> items = Json.arr(m.get("items"));
            List<Object> fixed = new ArrayList<Object>();
            for (Object io : items) {
                Map<String, Object> it = rec(io);
                Double want = repairedCostForItem(it);
                if (want == null) { fixed.add(it); continue; }
                Map<String, Object> copy = new LinkedHashMap<String, Object>(it);
                copy.put("cost", want);
                fixed.add(copy);
            }
            m.put("items", fixed);
            Map<String, Object> fin = memoMath(fixed, num(m.get("discount")),
                    num(m.get("deliveryCharge")), num(m.get("advance")));
            m.put("cogs", fin.get("cogs"));
            m.put("profit", fin.get("profit"));
        }
        return plan.size();
    }

    /* ============================ ageing ============================ */

    public Map<String, Object> ageingBuckets(List<Object> items, String todayStr) {
        long t = parseDate(todayStr == null || todayStr.isEmpty() ? today() : todayStr);
        double current = 0, d30 = 0, d60 = 0, d90 = 0, over90 = 0;
        for (Object o : items) {
            Map<String, Object> it = rec(o);
            double due = num(it.get("due"));
            if (due <= 0) continue;
            long days = (t - parseDate(str(it, "date"))) / 86400000L;
            if (days <= 30) current += due;
            else if (days <= 60) d30 += due;
            else if (days <= 90) d60 += due;
            else if (days <= 120) d90 += due;
            else over90 += due;
        }
        Map<String, Object> b = new LinkedHashMap<String, Object>();
        b.put("current", Double.valueOf(current));
        b.put("d30", Double.valueOf(d30));
        b.put("d60", Double.valueOf(d60));
        b.put("d90", Double.valueOf(d90));
        b.put("over90", Double.valueOf(over90));
        b.put("total", Double.valueOf(round2(current + d30 + d60 + d90 + over90)));
        return b;
    }

    private static long parseDate(String yyyyMmDd) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.parse(yyyyMmDd).getTime();
        } catch (Exception e) {
            return System.currentTimeMillis();
        }
    }

    /* ============================ document numbers ============================ */

    /** Memo numbers must not collide between PC and phone, and the Google Sheet upserts
     *  on the number, so the device tag is baked in rather than per-device counters. */
    public String deviceTag() {
        if (tagCache != null) return tagCache;
        String set = str(settings(), "deviceTag").trim();
        if (!set.isEmpty()) {
            String t = set.toUpperCase(Locale.US).replaceAll("[^A-Z0-9]", "");
            return t.length() > 6 ? t.substring(0, 6) : t;
        }
        String t = readFile(tagFile());
        if (t == null) t = "";
        t = t.trim();
        if (t.isEmpty()) {
            /* A bare "PH" collides: the phone app and the browser build of the web
               app on some other phone both fall back to it, and the sheet keeps one
               backup row per device tag. The two would then overwrite each other's
               snapshot, so the second saver silently replaces the first's books.
               The tag is minted once and kept, so it stays small and stable while
               still being unique per install. */
            t = "PH" + randomTag();
            // The folder may not exist yet on a fresh install, and a tag that cannot
            // be persisted would be re-minted on the next call - changing the device
            // tag mid-session and with it every memo number.
            if (dir != null && !dir.isDirectory()) dir.mkdirs();
            try { writeFile(tagFile(), t); } catch (IOException ignored) { }
        }
        tagCache = t;
        return t;
    }

    /** Four characters from the app's own id alphabet, for a per-install tag. */
    private static String randomTag() {
        String c = id();
        return c.length() >= 4 ? c.substring(0, 4).toUpperCase(Locale.US) : "0000";
    }

    public String nextMemoNo() {
        return str(settings(), "memoPrefix") + today().replace('-', '/') + "-" + deviceTag()
                + pad3(num(map("seq").get("memo")));
    }

    public String consumeMemoNo() {
        String no = nextMemoNo();
        Map<String, Object> seq = map("seq");
        seq.put("memo", Long.valueOf((long) num(seq.get("memo")) + 1));
        return no;
    }

    public String nextPurchaseNo() {
        return "TXP/PO/" + today().replace('-', '/') + "-" + deviceTag()
                + pad3(num(map("seq").get("purchase")));
    }

    private static String pad3(double n) {
        String s = Long.toString((long) n);
        while (s.length() < 3) s = "0" + s;
        return s;
    }

    /* ============================ merge / sync ============================ */

    private static Map<String, Object> bare(Map<String, Object> o) {
        Map<String, Object> c = new LinkedHashMap<String, Object>(o);
        c.remove("at");
        return c;
    }

    private static Map<String, Map<String, Object>> indexOne(List<Object> arr) {
        Map<String, Map<String, Object>> m = new LinkedHashMap<String, Map<String, Object>>();
        if (arr == null) return m;
        for (Object o : arr) {
            Map<String, Object> r = rec(o);
            String rid = str(r, "id");
            if (!rid.isEmpty()) m.put(rid, r);
        }
        return m;
    }

    private static Map<String, Map<String, Map<String, Object>>> indexRecs(Map<String, Object> d) {
        Map<String, Map<String, Map<String, Object>>> map =
            new LinkedHashMap<String, Map<String, Map<String, Object>>>();
        for (String k : MERGE_KEYS) map.put(k, indexOne(listOf(d, k)));
        return map;
    }

    /** The same index over a detached copy of the records. stampChanged compares this
     *  commit against the last one, and indexRecs holds the live objects - so an edit
     *  made in place (a password reset, a role change) looked identical to the previous
     *  commit and was never stamped, never pushed, and never reached the other machine.
     *  Round-tripping through JSON is what makes an in-place edit visible. */
    private static Map<String, Map<String, Map<String, Object>>> frozenIndex(Map<String, Object> d) {
        Map<String, Map<String, Map<String, Object>>> map =
            new LinkedHashMap<String, Map<String, Map<String, Object>>>();
        for (String k : MERGE_KEYS) {
            Object parsed = Json.read(Json.write(listOf(d, k)));
            map.put(k, indexOne(Json.arr(parsed)));
        }
        return map;
    }

    private void stampChanged(String now) {
        Map<String, Map<String, Map<String, Object>>> prev = lastCommitted;
        if (prev == null) return;
        for (String k : MERGE_KEYS) {
            Map<String, Map<String, Object>> before = prev.get(k);
            if (before == null) before = new LinkedHashMap<String, Map<String, Object>>();
            Map<String, Map<String, Object>> live = indexOne(list(k));
            for (Map.Entry<String, Map<String, Object>> e : live.entrySet()) {
                Map<String, Object> was = before.get(e.getKey());
                if (was == null) {
                    if (str(e.getValue(), "at").isEmpty()) e.getValue().put("at", now);
                    continue;
                }
                if (!Json.write(bare(e.getValue())).equals(Json.write(bare(was)))) {
                    e.getValue().put("at", now);
                }
            }
            // Present in the last commit, gone now: a delete, wherever it happened.
            for (String rid : before.keySet()) {
                if (!live.containsKey(rid)) markDeleted(k, rid, now);
            }
        }
    }

    private List<Object> tombstones() { return list("tombstones"); }

    private void markDeleted(String key, String rid, String at) {
        List<Object> t = new ArrayList<Object>(tombstones());
        for (Object o : t) {
            Map<String, Object> x = rec(o);
            if (str(x, "key").equals(key) && str(x, "id").equals(rid)) { x.put("at", at); putTomb(t); return; }
        }
        Map<String, Object> nt = new LinkedHashMap<String, Object>();
        nt.put("key", key);
        nt.put("id", rid);
        nt.put("at", at);
        t.add(nt);
        putTomb(t);
    }

    private void putTomb(List<Object> t) {
        while (t.size() > TOMB_MAX) t.remove(0);
        db.put("tombstones", t);
    }

    private static boolean isDeletedIn(Map<String, Object> d, String key, String rid) {
        for (Object o : listOf(d, "tombstones")) {
            Map<String, Object> x = rec(o);
            if (str(x, "key").equals(key) && str(x, "id").equals(rid)) return true;
        }
        return false;
    }

    private static List<Object> mergeTombstones(List<Object> a, List<Object> b) {
        List<Object> out = new ArrayList<Object>(a == null ? new ArrayList<Object>() : a);
        if (b != null) for (Object o : b) {
            Map<String, Object> t = rec(o);
            boolean found = false;
            for (Object oo : out) {
                Map<String, Object> x = rec(oo);
                if (str(x, "key").equals(str(t, "key")) && str(x, "id").equals(str(t, "id"))) {
                    if (str(t, "at").compareTo(str(x, "at")) > 0) x.put("at", t.get("at"));
                    found = true;
                    break;
                }
            }
            if (!found) out.add(t);
        }
        while (out.size() > TOMB_MAX) out.remove(0);
        return out;
    }

    /** Newest record wins; a record the other side deleted is not resurrected. */
    private static void mergeRecsInto(Map<String, Object> d1, Map<String, Object> d2) {
        Map<String, Map<String, Map<String, Object>>> a = indexRecs(d1);
        Map<String, Map<String, Map<String, Object>>> b = indexRecs(d2);
        for (String k : MERGE_KEYS) {
            if (!(d1.get(k) instanceof List)) d1.put(k, new ArrayList<Object>());
            for (Map.Entry<String, Map<String, Object>> e : b.get(k).entrySet()) {
                Map<String, Object> other = e.getValue();
                Map<String, Object> mine = a.get(k).get(e.getKey());
                if (mine == null) {
                    if (!isDeletedIn(d1, k, e.getKey()) && !isDeletedIn(d2, k, e.getKey())) {
                        listOf(d1, k).add(other);
                    }
                    continue;
                }
                if (str(other, "at").compareTo(str(mine, "at")) > 0) {
                    List<String> keys = new ArrayList<String>(mine.keySet());
                    for (String key : keys) if (!"id".equals(key)) mine.remove(key);
                    for (Map.Entry<String, Object> oe : other.entrySet()) mine.put(oe.getKey(), oe.getValue());
                }
            }
        }
    }

    private static void applyTombstones(Map<String, Object> d) {
        List<Object> keep = new ArrayList<Object>();
        for (Object o : listOf(d, "tombstones")) {
            Map<String, Object> t = rec(o);
            String key = str(t, "key");
            Map<String, Object> r = indexOne(listOf(d, key)).get(str(t, "id"));
            if (r == null) { keep.add(t); continue; }
            if (str(r, "at").compareTo(str(t, "at")) > 0) continue;   // edited after delete
            List<Object> filtered = new ArrayList<Object>();
            for (Object x : listOf(d, key)) if (!str(x, "id").equals(str(t, "id"))) filtered.add(x);
            d.put(key, filtered);
            keep.add(t);
        }
        while (keep.size() > TOMB_MAX) keep.remove(0);
        d.put("tombstones", keep);
    }

    public void mergeCloudInto(Map<String, Object> incoming) {
        synchronized (lock) {
            mergeCloudIntoLocked(incoming);
        }
    }

    private void mergeCloudIntoLocked(Map<String, Object> incoming) {
        mergeRecsInto(db, incoming);
        db.put("tombstones", mergeTombstones(list("tombstones"), listOf(incoming, "tombstones")));
        applyTombstones(db);
        mergeUsersInto();
        mergeSettingsInto(incoming);
        rebaseStockFromLedger();
        ensureUsersQuiet();
    }

    /* Business settings, newest wins. The settings object carries no per-record
       stamp, so the timestamps the writing device left behind are what says which
       side changed last. A field the other side has never filled in is taken as-is,
       which is what makes the owner's company details appear on a machine that was
       installed later. */
    @SuppressWarnings("unchecked")
    private void mergeSettingsInto(Map<String, Object> incoming) {
        Object raw = incoming == null ? null : incoming.get("settings");
        if (!(raw instanceof Map)) return;
        Map<String, Object> inSet = cast(raw);
        Map<String, Object> mine = settings();
        Map<String, Object> inCompany = cast(inSet.get("company"));
        Map<String, Object> myCompany = company();
        String inCompanyAt = str(inSet, "companyUpdatedAt");
        String myCompanyAt = str(mine, "companyUpdatedAt");
        for (Map.Entry<String, Object> e : inCompany.entrySet()) {
            Object theirs = e.getValue();
            if (theirs == null || String.valueOf(theirs).isEmpty()) continue;
            Object ours = myCompany.get(e.getKey());
            if (ours == null || String.valueOf(ours).isEmpty()) {
                myCompany.put(e.getKey(), theirs);
            } else if (!Json.write(ours).equals(Json.write(theirs)) && inCompanyAt.compareTo(myCompanyAt) > 0) {
                myCompany.put(e.getKey(), theirs);
            }
        }
        String inSettingsAt = str(inSet, "settingsUpdatedAt");
        String mySettingsAt = str(mine, "settingsUpdatedAt");
        for (Map.Entry<String, Object> e : inSet.entrySet()) {
            String k = e.getKey();
            if ("company".equals(k) || isLocalSetting(k)) continue;
            Object theirs = e.getValue();
            if (theirs == null) continue;
            Object ours = mine.get(k);
            if (ours == null) { mine.put(k, theirs); continue; }
            if (Json.write(ours).equals(Json.write(theirs))) continue;
            if (inSettingsAt.compareTo(mySettingsAt) > 0) mine.put(k, theirs);
        }
        if (inCompanyAt.compareTo(myCompanyAt) > 0) mine.put("companyUpdatedAt", inCompanyAt);
        if (inSettingsAt.compareTo(mySettingsAt) > 0) mine.put("settingsUpdatedAt", inSettingsAt);
    }

    private static boolean isLocalSetting(String k) {
        for (String s : LOCAL_SETTING_KEYS) if (s.equals(k)) return true;
        return false;
    }

    /* One account per username, whichever device created it. Two machines that each
       started fresh both hold an `admin` with different ids, and without this the
       merge produced two admins and the login took whichever came first. The newest
       record wins, so a password reset on the PC still works on the phone. */
    @SuppressWarnings("unchecked")
    private void mergeUsersInto() {
        Map<String, Map<String, Object>> seen = new LinkedHashMap<String, Map<String, Object>>();
        List<Object> out = new ArrayList<Object>();
        for (Object o : list("users")) {
            Map<String, Object> u = rec(o);
            String un = str(u, "username").toLowerCase();
            if (un.isEmpty()) continue;
            Map<String, Object> prev = seen.get(un);
            if (prev == null) { seen.put(un, u); out.add(u); continue; }
            if (str(u, "at").compareTo(str(prev, "at")) > 0) {
                List<String> keys = new ArrayList<String>(prev.keySet());
                for (String k : keys) if (!"id".equals(k)) prev.remove(k);
                for (Map.Entry<String, Object> oe : u.entrySet()) prev.put(oe.getKey(), oe.getValue());
            }
        }
        db.put("users", out);
    }

    /** Rebuild the stock book from the ledger so it agrees with the memos actually
     *  left after a merge. A recomputation, not a second subtraction pass: two
     *  devices' counters cannot drift apart if they are re-derived, not adjusted. */
    public void rebaseStockFromLedger() {
        Map<String, Map<String, Object>> byProduct = new LinkedHashMap<String, Map<String, Object>>();
        for (Object o : list("ledger")) {
            Map<String, Object> l = rec(o);
            String pid = str(l, "productId");
            if (pid.isEmpty()) continue;
            // A deleted product has no ledger worth replaying: rebuilding its card
            // would leave a "(deleted product)" row reading as stock still owned.
            if (productById(pid) == null) continue;
            Map<String, Object> b = byProduct.get(pid);
            if (b == null) { b = new LinkedHashMap<String, Object>(); b.put("opening", 0.0); b.put("purchased", 0.0); b.put("sold", 0.0); byProduct.put(pid, b); }
            String type = str(l, "type");
            double q = num(l.get("qty"));
            if ("Opening".equals(type) || "AutoAdd".equals(type)) b.put("opening", num(b.get("opening")) + q);
            else if ("Purchase".equals(type)) b.put("purchased", num(b.get("purchased")) + q);
            else if ("Sale".equals(type)) b.put("sold", num(b.get("sold")) - q);
            else if ("SaleReturn".equals(type)) b.put("sold", num(b.get("sold")) - q);
            /* A parcel that came back sellable is no longer sold, the same slot a memo
             *  delete frees. A damaged one never re-enters `sold`. This case was missing
             *  here while the web build had it, so a sync on the phone rebuilt `sold` too
             *  high and the shop read short by the returned qty. */
            else if ("Return".equals(type)) b.put("sold", num(b.get("sold")) - q);
            /* The native app writes ReturnUndo where the web writes Sale for the same
             *  event (a deleted return), and the two apps share one sheet, so each must
             *  understand the other's entry or a sync would rebuild `sold` wrongly. */
            else if ("ReturnUndo".equals(type)) b.put("sold", num(b.get("sold")) - q);
            else if ("Adjustment".equals(type) || "Damage".equals(type)) b.put("purchased", num(b.get("purchased")) + q);
        }
        Map<String, Map<String, Object>> cards = new LinkedHashMap<String, Map<String, Object>>();
        for (Object o : list("stock")) {
            Map<String, Object> s = rec(o);
            if (!str(s, "productId").isEmpty()) cards.put(str(s, "productId"), s);
        }
        for (Map.Entry<String, Map<String, Object>> e : byProduct.entrySet()) {
            Map<String, Object> t = e.getValue();
            Map<String, Object> s = cards.get(e.getKey());
            if (s == null) {
                s = new LinkedHashMap<String, Object>();
                s.put("id", id());
                s.put("productId", e.getKey());
                s.put("cost", Long.valueOf(0));
                list("stock").add(s);
                cards.put(e.getKey(), s);
            }
            s.put("opening", Double.valueOf(num(t.get("opening"))));
            s.put("purchased", Double.valueOf(num(t.get("purchased"))));
            s.put("sold", Double.valueOf(num(t.get("sold"))));
            s.put("available", Double.valueOf(stockAvailable(s)));
        }
        for (Object o : list("stock")) {
            Map<String, Object> s = rec(o);
            s.put("available", Double.valueOf(stockAvailable(s)));
        }
        dedupeStockCards();
    }

    /** One card per product. Each device used to mint its own random card id for the
     *  same product, so a merge could leave two and the stock page listed it twice. */
    public void dedupeStockCards() {
        Map<String, Map<String, Object>> seen = new LinkedHashMap<String, Map<String, Object>>();
        List<Object> out = new ArrayList<Object>();
        for (Object o : list("stock")) {
            Map<String, Object> s = rec(o);
            String pid = str(s, "productId");
            if (pid.isEmpty()) continue;
            Map<String, Object> first = seen.get(pid);
            if (first != null) {
                if (num(first.get("cost")) == 0 && num(s.get("cost")) != 0) first.put("cost", s.get("cost"));
                continue;
            }
            seen.put(pid, s);
            out.add(s);
        }
        db.put("stock", out);
    }

    /* ============================ snapshots ============================ */

    /** The rolling safety copies, newest first. Public so Backup can offer them. */
    public List<Object> listSnapshots() {
        String cur = readFile(snapFile());
        if (cur == null) return new ArrayList<Object>();
        Object parsed = Json.read(cur);
        return parsed instanceof List ? Json.arr(parsed) : new ArrayList<Object>();
    }

    /** Replaces the working data with a safety copy. Returns a message for the UI. */
    public String restoreSnapshot(int index) {
        List<Object> arr = listSnapshots();
        if (index < 0 || index >= arr.size()) return "Snapshot nei.";
        Map<String, Object> snap = rec(arr.get(index));
        String data = str(snap, "data");
        Object parsed = Json.read(data);
        if (!(parsed instanceof Map)) return "Snapshot ta thik na.";
        db = migrate(cast(parsed));
        ensureUsers();
        lastCommitted = null;
        commit();
        return "Snapshot restore hoyeche.";
    }

    private void snapshot() {
        try {
            String cur = readFile(snapFile());
            List<Object> arr = cur == null ? new ArrayList<Object>()
                    : (Json.read(cur) instanceof List ? Json.arr(Json.read(cur)) : new ArrayList<Object>());
            String sig = list("memos").size() + "|" + list("products").size() + "|"
                    + list("purchases").size() + "|" + list("stock").size();
            if (!arr.isEmpty()) {
                Map<String, Object> last = rec(arr.get(0));
                if (sig.equals(str(last, "sig")) && System.currentTimeMillis() - num(last.get("at")) < 60000) return;
            }
            Map<String, Object> snap = new LinkedHashMap<String, Object>();
            snap.put("at", Long.valueOf(System.currentTimeMillis()));
            snap.put("sig", sig);
            snap.put("data", Json.write(db));
            arr.add(0, snap);
            while (arr.size() > SNAP_COUNT) arr.remove(arr.size() - 1);
            writeFile(snapFile(), Json.write(arr));
        } catch (Exception e) { /* best-effort; never block a save */ }
    }
}
