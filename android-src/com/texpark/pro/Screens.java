package com.texpark.pro;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.content.DialogInterface;
import android.graphics.Typeface;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.DatePicker;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The app shell: the top bar, the scrolling sidebar, and the screen dispatcher.
 *
 * This is the native replacement for the WebView. The screens are the same pages
 * the web app had - the owner already knows them - but drawn with real Android
 * views, so the keyboard, the back button, the date picker and the font render the
 * way a phone app should.
 *
 * Every screen is rebuilt from the database on demand rather than kept in sync by
 * hand. The database is small (one shop's records) and a rebuild cannot go stale,
 * which is the failure the web version kept hitting when a view held a copy.
 */
public class Screens {

    /** One sidebar entry: page id, Bangla label, and permission key. */
    static final class NavItem {
        final String id, label;
        NavItem(String id, String label) { this.id = id; this.label = label; }
    }

    /** Everything the sidebar can show. The permission check hides the rest. */
    static final List<NavItem> ALL_NAV = Arrays.asList(
        new NavItem("dashboard", "Dashboard"),
        new NavItem("memo", "New Sales Memo"),
        new NavItem("history", "Memo History"),
        new NavItem("delivery", "Delivery Tracking"),
        new NavItem("customers", "Customers"),
        new NavItem("ledger", "Customer Ledger"),
        new NavItem("products", "Products"),
        new NavItem("stock", "Stock"),
        new NavItem("stockledger", "Stock Ledger"),
        new NavItem("purchase", "Purchases"),
        new NavItem("supplier", "Suppliers"),
        new NavItem("profit", "Profit / Item"),
        new NavItem("pl", "Profit & Loss"),
        new NavItem("ledgerreport", "Ledger / Ageing"),
        new NavItem("expense", "Expenses"),
        new NavItem("users", "Users & Roles"),
        new NavItem("settings", "Settings"),
        new NavItem("backup", "Backup / Data")
    );

    final Activity act;
    final Store store;
    final LinearLayout content;      // where a page is drawn
    final TextView badge;            // company tag line in the top bar
    final LinearLayout navWrap;      // the slide-out sidebar
    final View dim;                  // grey backdrop behind the sidebar

    String page = "dashboard";
    boolean navOpen = false;
    /** The live totals card on the memo form, redrawn in place as figures change. */
    public LinearLayout totalsHolder;

    /** The memo being written, kept across rebuilds so typing is never lost. */
    MemoDraft draft = new MemoDraft();
    /** The purchase being written, for the same reason. A poll that finds new data
     *  rebuilds the screen, and a purchase half typed at that moment used to go with
     *  it. */
    PurchaseDraft purchase = new PurchaseDraft();
    /** Which memo an update form is for, if any. */
    String deliveryMemoId = null;

    public Screens(Activity act, Store store, LinearLayout content, TextView badge,
                   LinearLayout navWrap, View dim) {
        this.act = act;
        this.store = store;
        this.content = content;
        this.badge = badge;
        this.navWrap = navWrap;
        this.dim = dim;
    }

    /* ------------------------------------------------------------ shell */

    public void refreshChrome() {
        Map<String, Object> c = store.company();
        badge.setText(Store.str(c, "name") + " \u2022 " + Store.str(c, "tagline"));
    }

    public void openNav(boolean open) {
        navOpen = open;
        navWrap.setVisibility(open ? View.VISIBLE : View.GONE);
        dim.setVisibility(open ? View.VISIBLE : View.GONE);
    }

    public void buildNav() {
        navWrap.removeAllViews();
        TextView head = new TextView(act);
        head.setText("TEXPARK Pro");
        head.setTextColor(0xFFFFFFFF);
        head.setTextSize(17f);
        head.setTypeface(Typeface.DEFAULT_BOLD);
        int p = Ui.dp(act, 14);
        head.setPadding(p, p, p, Ui.dp(act, 4));
        navWrap.addView(head);

        TextView sub = new TextView(act);
        sub.setText(Store.str(store.session, "name") + " (" + Store.str(store.session, "role") + ")");
        sub.setTextColor(0xFFB9C8DE);
        sub.setTextSize(12f);
        sub.setPadding(p, 0, p, Ui.dp(act, 8));
        navWrap.addView(sub);

        for (final NavItem it : ALL_NAV) {
            if (!store.can(it.id)) continue;
            TextView t = new TextView(act);
            t.setText(it.label);
            t.setTextColor(it.id.equals(page) ? 0xFFFFFFFF : 0xFFD5DEEB);
            t.setTextSize(14.5f);
            if (it.id.equals(page)) t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setPadding(p, Ui.dp(act, 11), p, Ui.dp(act, 11));
            t.setBackgroundColor(it.id.equals(page) ? 0xFF1C4C93 : 0x00000000);
            t.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    openNav(false);
                    go(it.id);
                }
            });
            navWrap.addView(t);
        }

        Button out = Ui.button(act, "Sign out", 0xFF2A2F3A);
        out.setTextColor(0xFFFFFFFF);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(p, Ui.dp(act, 18), p, p);
        out.setLayoutParams(lp);
        out.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                store.session = null;
                go("dashboard");
            }
        });
        navWrap.addView(out);
    }

    public void go(String to) {
        page = to;
        render();
    }

    public void render() {
        refreshChrome();
        buildNav();
        content.removeAllViews();
        if (store.session == null) {
            content.addView(loginScreen());
            return;
        }
        if (!store.can(page)) {
            page = "dashboard";
        }
        View v;
        if ("memo".equals(page)) v = ScreensData.newMemo(this);
        else if ("history".equals(page)) v = ScreensData.memoHistory(this);
        else if ("products".equals(page)) v = ScreensData.products(this);
        else if ("stock".equals(page)) v = ScreensData.stock(this);
        else if ("stockledger".equals(page)) v = ScreensData.stockLedger(this);
        else if ("customers".equals(page)) v = ScreensMore.customers(this);
        else if ("ledger".equals(page)) v = ScreensMore.customerLedger(this);
        else if ("ledgerreport".equals(page)) v = ScreensMore.ageing(this);
        else if ("supplier".equals(page)) v = ScreensMore.suppliers(this);
        else if ("purchase".equals(page)) v = ScreensMore.purchases(this);
        else if ("delivery".equals(page)) v = ScreensMore.delivery(this);
        else if ("profit".equals(page)) v = ScreensMore.profitByItem(this);
        else if ("pl".equals(page)) v = ScreensMore.profitAndLoss(this);
        else if ("expense".equals(page)) v = ScreensMore.expenses(this);
        else if ("users".equals(page)) v = ScreensMore.users(this);
        else if ("settings".equals(page)) v = ScreensMore.settings(this);
        else if ("backup".equals(page)) v = ScreensMore.backup(this);
        else v = dashboard();
        content.addView(v);
    }

    public void toast(String m) {
        Toast.makeText(act, m, Toast.LENGTH_LONG).show();
    }

    public void afterSave(String message) {
        store.commit();
        if (message != null && !message.isEmpty()) toast(message);
        render();
    }

    /* ------------------------------------------------------------ login */

    View loginScreen() {
        LinearLayout body = Ui.col(act);
        body.setGravity(Gravity.CENTER_HORIZONTAL);
        body.setPadding(Ui.dp(act, 20), Ui.dp(act, 60), Ui.dp(act, 20), Ui.dp(act, 20));

        TextView t = new TextView(act);
        t.setText("TEXPARK Pro");
        t.setTextColor(Ui.NAVY);
        t.setTextSize(26f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        body.addView(t);

        TextView s = new TextView(act);
        s.setText("Business Manager \u2014 sign in to continue");
        s.setTextColor(Ui.MUTED);
        s.setTextSize(13f);
        s.setPadding(0, Ui.dp(act, 4), 0, Ui.dp(act, 18));
        body.addView(s);

        final EditText u = Ui.field(act, "Username", "", InputType.TYPE_CLASS_TEXT);
        final EditText pw = Ui.field(act, "Password", "", InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        body.addView(u);
        body.addView(pw);

        Button go = Ui.button(act, "Sign in", Ui.NAVY);
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        go.setLayoutParams(glp);
        go.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (store.login(u.getText().toString(), pw.getText().toString())) {
                    go("dashboard");
                } else {
                    toast("Username ba password bhul.");
                }
            }
        });
        body.addView(go);

        TextView hint = new TextView(act);
        hint.setText("First time login: username admin, password admin123.\n"
                + "Login korar por Settings \u2192 Change my password theke password bodle nin.");
        hint.setTextColor(Ui.MUTED);
        hint.setTextSize(11.5f);
        hint.setPadding(0, Ui.dp(act, 14), 0, 0);
        body.addView(hint);

        ScrollView sc = Ui.scroller(act, body);
        return sc;
    }

    /* ------------------------------------------------------------ dashboard */

    View dashboard() {
        LinearLayout body = Ui.col(act);
        String today = Store.today();
        Map<String, Object> plToday = store.plSummary(today, today);
        String monthStart = today.substring(0, 8) + "01";
        Map<String, Object> plMonth = store.plSummary(monthStart, today);

        /* An unpaired device shows a fresh, empty shop: three demo products at 0 and
           every figure zero. Nothing said why, so it read as the data being gone. Say
           it at the top of the page he actually opens, with the one fix available. */
        String syncUrl = Store.str(store.settings(), "syncUrl");
        if (syncUrl.isEmpty()) {
            LinearLayout warn = Ui.card(act, "\u26A0 Sync bondho \u2014 onno device-er data ekhane ashbe na");
            warn.addView(Ui.label(act,
                "Ei device ta ekhono Google Sheet-er sathe joda lage ni. Tai onno device-e "
                + "(PC/phone) lekha memo/stock ekhane dekhabe na, ar ekhane lekha data-o "
                + "onno jaygay jabe na. Settings \u2192 Google Sheets Sync-e giye Apps "
                + "Script-er /exec URL ta bosan."));
            Button openSettings = Ui.primary(act, "Settings-e URL bosan");
            openSettings.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { go("settings"); }
            });
            warn.addView(openSettings);
            body.addView(warn);
        }

        body.addView(Ui.kpiRow(act,
            Ui.kpi(act, Ui.money(plToday.get("sales")), "Aaj-er bikri", Ui.NAVY),
            Ui.kpi(act, Ui.money(plToday.get("grossProfit")), "Aaj-er labh", Ui.GREEN)));
        body.addView(Ui.kpiRow(act,
            Ui.kpi(act, Ui.money(plMonth.get("sales")), "Cholti mash", Ui.NAVY),
            Ui.kpi(act, Ui.money(plMonth.get("grossProfit")), "Cholti mash labh", Ui.GREEN)));
        body.addView(Ui.kpiRow(act,
            Ui.kpi(act, Ui.money(store.totalReceivable()), "Receivable (pabo)", Ui.AMBER),
            Ui.kpi(act, Ui.money(store.totalPayable()), "Payable (dibo)", Ui.RED)));
        body.addView(Ui.kpiRow(act,
            Ui.kpi(act, Ui.money(store.stockValue()), "Stock Value", Ui.NAVY),
            Ui.kpi(act, Ui.money(store.plSummary("", "").get("netProfit")), "Net Profit (all)", Ui.GREEN)));

        // Last 14 days, as a simple bar list - a chart library would drag in
        // dependencies the no-Gradle build cannot resolve.
        LinearLayout days = Ui.card(act, "Last 14 days \u2014 Sales");
        double max = 1;
        List<String> labels = new ArrayList<String>();
        List<Double> vals = new ArrayList<Double>();
        Calendar cal = Calendar.getInstance();
        for (int i = 13; i >= 0; i--) {
            Calendar c = (Calendar) cal.clone();
            c.add(Calendar.DAY_OF_MONTH, -i);
            String d = String.format(Locale.US, "%04d-%02d-%02d",
                    c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
            double v = Store.num(store.plSummary(d, d).get("sales"));
            labels.add(d.substring(5));
            vals.add(v);
            if (v > max) max = v;
        }
        for (int i = 0; i < labels.size(); i++) {
            LinearLayout r = Ui.row(act);
            TextView lb = new TextView(act);
            lb.setText(labels.get(i));
            lb.setTextSize(11.5f);
            lb.setTextColor(Ui.MUTED);
            lb.setWidth(Ui.dp(act, 48));
            r.addView(lb);
            View bar = new View(act);
            bar.setBackgroundColor(i == labels.size() - 1 ? Ui.PINK : Ui.NAVY);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    Math.max(1, (int) (Ui.dp(act, 140) * (vals.get(i) / max))), Ui.dp(act, 12));
            blp.setMargins(0, Ui.dp(act, 2), Ui.dp(act, 6), Ui.dp(act, 2));
            bar.setLayoutParams(blp);
            r.addView(bar);
            TextView vl = new TextView(act);
            vl.setText(Ui.money(vals.get(i)));
            vl.setTextSize(11.5f);
            vl.setTextColor(Ui.TEXT);
            r.addView(vl);
            days.addView(r);
        }
        body.addView(days);

        // Low stock alert
        LinearLayout low = Ui.card(act, "Low Stock Alert");
        int n = 0;
        for (Object o : store.list("products")) {
            Map<String, Object> p = Store.rec(o);
            Map<String, Object> s = store.findStock(Store.str(p, "id"));
            double avail = s == null ? 0 : Store.num(s.get("available"));
            double reorder = Store.num(p.get("reorderLevel"));
            if (avail <= reorder) {
                n++;
                low.addView(Ui.cells(act,
                    new String[]{Store.str(p, "name"), Ui.qty(avail)},
                    new float[]{3f, 1f}, avail <= 0 ? Ui.RED : Ui.AMBER, false));
            }
        }
        if (n == 0) low.addView(Ui.label(act, "Sob product-er stock thik ache."));
        body.addView(low);

        // Recent memos
        LinearLayout rec = Ui.card(act, "Recent Memos");
        List<Object> memos = store.list("memos");
        int shown = 0;
        for (int i = memos.size() - 1; i >= 0 && shown < 8; i--, shown++) {
            final Map<String, Object> m = Store.rec(memos.get(i));
            LinearLayout r = Ui.cells(act,
                new String[]{Store.str(m, "date"), Store.str(m, "memoNo"),
                             Store.str(m, "customerName"), Ui.money(m.get("grandTotal"))},
                new float[]{2.2f, 3f, 3f, 2f}, Ui.TEXT, false);
            r.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { ScreensData.viewMemo(Screens.this, Store.str(m, "id")); }
            });
            rec.addView(r);
        }
        if (shown == 0) rec.addView(Ui.label(act, "Ekhono kono memo nei."));
        body.addView(rec);

        // Delivery pending
        LinearLayout dp = Ui.card(act, "Delivery Pending");
        int dpc = 0;
        for (Object o : store.list("deliveries")) {
            Map<String, Object> d = Store.rec(o);
            double left = Store.num(d.get("qty")) - Store.num(d.get("delivered"));
            if (left <= 0) continue;
            dpc++;
            dp.addView(Ui.cells(act,
                new String[]{Store.str(d, "memoNo"), Store.str(d, "receiver"),
                             Ui.qty(left)},
                new float[]{3f, 3f, 1.6f}, Ui.AMBER, false));
        }
        if (dpc == 0) dp.addView(Ui.label(act, "Kono delivery baki nei."));
        body.addView(dp);

        return Ui.scroller(act, body);
    }

    /* ------------------------------------------------------------ shared bits */

    /** A date field that opens the real Android date picker. */
    EditText dateField(final String initial, final String hint) {
        final EditText e = Ui.field(act, hint, initial == null || initial.isEmpty()
                ? Store.today() : initial, InputType.TYPE_CLASS_TEXT);
        e.setFocusable(false);
        e.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                final String cur = e.getText().toString();
                int y = 2000, m = 1, d = 1;
                try {
                    y = Integer.parseInt(cur.substring(0, 4));
                    m = Integer.parseInt(cur.substring(5, 7)) - 1;
                    d = Integer.parseInt(cur.substring(8, 10));
                } catch (Exception ignored) { }
                new DatePickerDialog(act, new DatePickerDialog.OnDateSetListener() {
                    public void onDateSet(DatePicker view, int yy, int mm, int dd) {
                        e.setText(String.format(Locale.US, "%04d-%02d-%02d", yy, mm + 1, dd));
                    }
                }, y, m, d).show();
            }
        });
        return e;
    }

    /** Asks before anything destructive, then runs it. */
    void confirm(String message, final Runnable then) {
        new AlertDialog.Builder(act)
            .setMessage(message)
            .setPositiveButton("Hyan", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { then.run(); }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /** A one-field prompt, used for quantities and payments. */
    void prompt(final String title, final String hint, final boolean numeric, final OnText then) {
        final EditText e = numeric ? Ui.number(act, hint, "") : Ui.field(act, hint, "",
                InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(act)
            .setTitle(title)
            .setView(e)
            .setPositiveButton("Thik ache", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { then.on(e.getText().toString()); }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    public interface OnText { void on(String text); }

    /** A picker list: shows labels, returns the index chosen. */
    void choose(String title, final List<String> labels, final OnText then) {
        new AlertDialog.Builder(act)
            .setTitle(title)
            .setItems(labels.toArray(new String[0]), new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int which) {
                    then.on(String.valueOf(which));
                }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /* ------------------------------------------------------------ memo draft */

    /**
     * The memo form's live state.
     *
     * The web app kept this in DOM inputs and rebuilt the item table under the
     * owner's cursor, which is the bug the old tests were written around. Keeping
     * it in an object means a rebuild reuses the same values and the same row
     * structure, so nothing the owner typed is lost and the cursor has nowhere to
     * jump to.
     */
    public static class MemoDraft {
        public String memoNo = "";
        public String date = "";
        public String customerName = "";
        public String customerPhone = "";
        public String customerAddress = "";
        public String customerId = "";
        public String note = "";
        public String discount = "", delivery = "", advance = "";
        public final List<Line> lines = new ArrayList<Line>();

        public static class Line {
            public String productId = "";
            public String qty = "", rate = "", cost = "", vat = "";
        }

        public MemoDraft() {
            lines.add(new Line());
        }

        public void reset(Store store) {
            memoNo = "";
            date = Store.today();
            customerName = "";
            customerPhone = "";
            customerAddress = "";
            customerId = "";
            note = "";
            discount = "";
            delivery = "";
            advance = "";
            lines.clear();
            lines.add(new Line());
        }

        /** The filled rows, in the shape the rules expect. */
        public List<Object> items(Store store) {
            List<Object> out = new ArrayList<Object>();
            for (Line l : lines) {
                if (l.productId.isEmpty() || Store.num(l.qty) <= 0) continue;
                Map<String, Object> it = new LinkedHashMap<String, Object>();
                it.put("productId", l.productId);
                it.put("qty", Double.valueOf(Store.num(l.qty)));
                it.put("rate", Double.valueOf(Store.num(l.rate)));
                it.put("cost", l.cost.isEmpty()
                        ? Double.valueOf(store.stockCost(l.productId))
                        : Double.valueOf(Store.num(l.cost)));
                it.put("vat", l.vat.isEmpty() ? Double.valueOf(0) : Double.valueOf(Store.num(l.vat)));
                out.add(it);
            }
            return out;
        }
    }

    /** The purchase form's fields, held outside the view tree. The screen is rebuilt
     *  whenever a sync brings something new, and an EditText that lives only in the
     *  tree takes whatever was typed in it to the grave. */
    public static class PurchaseDraft {
        public String no = "";
        public String date = "";
        public String supplier = "";
        public String product = "";
        public String qty = "";
        public String cost = "";
        public String paid = "";
        public String note = "";

        public void reset(Store store) {
            no = "";
            date = Store.today();
            supplier = "";
            product = "";
            qty = "";
            cost = "";
            paid = "";
            note = "";
        }
    }
}
