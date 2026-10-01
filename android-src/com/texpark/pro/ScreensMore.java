package com.texpark.pro;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The rest of the screens: customers, suppliers, purchases, delivery, the reports,
 * expenses, users, settings and backup.
 *
 * Nothing here changes a money rule - it all goes through Store, so what a report
 * shows is what the memo maths produced. Where a figure could be misread, the
 * screen says in words what it means rather than leaving a bare number.
 */
public class ScreensMore {

    private ScreensMore() {}

    /* ============================ customers ============================ */

    static View customers(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);
        LinearLayout form = Ui.card(s.act, "Customer");
        final EditText name = Ui.field(s.act, "Name", "", InputType.TYPE_CLASS_TEXT);
        final EditText phone = Ui.field(s.act, "Phone", "", InputType.TYPE_CLASS_PHONE);
        final EditText addr = Ui.field(s.act, "Address", "", InputType.TYPE_CLASS_TEXT);
        form.addView(name);
        form.addView(phone);
        form.addView(addr);
        Button save = Ui.primary(s.act, "Save Customer");
        save.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (name.getText().toString().trim().isEmpty()) { s.toast("Nam din."); return; }
                Map<String, Object> c = new LinkedHashMap<String, Object>();
                c.put("id", Store.id());
                c.put("name", name.getText().toString().trim());
                c.put("phone", phone.getText().toString().trim());
                c.put("address", addr.getText().toString().trim());
                store.list("customers").add(c);
                s.afterSave("Customer save hoyeche.");
            }
        });
        form.addView(save);
        body.addView(form);

        LinearLayout list = Ui.card(s.act, "Customer list");
        list.addView(Ui.cells(s.act,
            new String[]{"NAME", "PHONE", "BIZ", "DUE"},
            new float[]{3.6f, 2.6f, 2f, 2f}, Ui.NAVY, true));
        list.addView(Ui.divider(s.act));
        for (Object o : store.list("customers")) {
            final Map<String, Object> c = Store.rec(o);
            String cid = Store.str(c, "id");
            double biz = 0, due = 0;
            for (Object mo : store.list("memos")) {
                Map<String, Object> m = Store.rec(mo);
                if (cid.equals(Store.str(m, "customerId"))
                        || (!Store.str(m, "customerName").isEmpty()
                            && Store.str(m, "customerName").equals(Store.str(c, "name")))) {
                    biz += Store.num(m.get("grandTotal"));
                    due += Store.num(m.get("due"));
                }
            }
            LinearLayout r = Ui.cells(s.act,
                new String[]{Store.str(c, "name"), Store.str(c, "phone"),
                             Ui.money(biz), Ui.money(due)},
                new float[]{3.6f, 2.6f, 2f, 2f}, due > 0 ? Ui.AMBER : Ui.TEXT, false);
            final double dueFig = due;
            r.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    s.prompt("Receive from " + Store.str(c, "name"), "Amount", true,
                        new Screens.OnText() {
                            public void on(String text) {
                                double amt = Store.num(text);
                                if (amt <= 0) return;
                                Map<String, Object> pay = new LinkedHashMap<String, Object>();
                                pay.put("id", Store.id());
                                pay.put("date", Store.today());
                                pay.put("customerId", Store.str(c, "id"));
                                pay.put("customerName", Store.str(c, "name"));
                                pay.put("amount", Double.valueOf(amt));
                                pay.put("method", "Cash");
                                pay.put("note", "Received payment");
                                store.list("payments").add(pay);
                                applyPayment(store, Store.str(c, "id"), Store.str(c, "name"), amt);
                                s.afterSave("Payment niye newa hoyeche.");
                            }
                        });
                }
            });
            list.addView(r);
            if (due != 0) {
                list.addView(Ui.label(s.act, "Baki " + Ui.money(dueFig) + " \u2014 tap kore payment nin"));
            }
        }
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    /** Oldest due first, so a payment clears the debt that has waited longest. */
    static void applyPayment(Store store, String customerId, String customerName, double amount) {
        List<Object> memos = store.list("memos");
        List<Map<String, Object>> owing = new ArrayList<Map<String, Object>>();
        for (Object o : memos) {
            Map<String, Object> m = Store.rec(o);
            boolean mine = customerId.equals(Store.str(m, "customerId"))
                    || (!customerName.isEmpty() && customerName.equals(Store.str(m, "customerName")));
            if (mine && Store.num(m.get("due")) > 0) owing.add(m);
        }
        java.util.Collections.sort(owing, new java.util.Comparator<Map<String, Object>>() {
            public int compare(Map<String, Object> a, Map<String, Object> b) {
                return Store.str(a, "date").compareTo(Store.str(b, "date"));
            }
        });
        double left = amount;
        for (Map<String, Object> m : owing) {
            if (left <= 0) break;
            double due = Store.num(m.get("due"));
            double use = Math.min(due, left);
            m.put("advance", Double.valueOf(Store.num(m.get("advance")) + use));
            m.put("due", Double.valueOf(Store.round2(due - use)));
            left = Store.round2(left - use);
        }
    }

    /* ============================ customer ledger ============================ */

    static View customerLedger(final Screens s) {
        LinearLayout body = Ui.col(s.act);
        LinearLayout list = Ui.card(s.act, "Customer Ledger");
        list.addView(Ui.cells(s.act,
            new String[]{"CUSTOMER", "BILLED", "PAID", "DUE"},
            new float[]{3.4f, 2f, 2f, 2f}, Ui.NAVY, true));
        list.addView(Ui.divider(s.act));
        Map<String, double[]> byName = new LinkedHashMap<String, double[]>();
        for (Object o : s.store.list("memos")) {
            Map<String, Object> m = Store.rec(o);
            String key = Store.str(m, "customerName");
            if (key.isEmpty()) key = "(no name)";
            double[] t = byName.get(key);
            if (t == null) { t = new double[2]; byName.put(key, t); }
            t[0] += Store.num(m.get("grandTotal"));
            t[1] += Store.num(m.get("due"));
        }
        for (Map.Entry<String, double[]> e : byName.entrySet()) {
            double billed = e.getValue()[0], due = e.getValue()[1];
            list.addView(Ui.cells(s.act,
                new String[]{e.getKey(), Ui.money(billed), Ui.money(billed - due), Ui.money(due)},
                new float[]{3.4f, 2f, 2f, 2f}, due > 0 ? Ui.AMBER : Ui.TEXT, false));
        }
        if (byName.isEmpty()) list.addView(Ui.label(s.act, "Kono memo nei."));
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    /* ============================ suppliers ============================ */

    static View suppliers(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);
        LinearLayout form = Ui.card(s.act, "Supplier");
        final EditText name = Ui.field(s.act, "Supplier Name", "", InputType.TYPE_CLASS_TEXT);
        final EditText person = Ui.field(s.act, "Contact Person", "", InputType.TYPE_CLASS_TEXT);
        final EditText phone = Ui.field(s.act, "Phone", "", InputType.TYPE_CLASS_PHONE);
        final EditText addr = Ui.field(s.act, "Address", "", InputType.TYPE_CLASS_TEXT);
        form.addView(name); form.addView(person); form.addView(phone); form.addView(addr);
        Button save = Ui.primary(s.act, "Save Supplier");
        save.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (name.getText().toString().trim().isEmpty()) { s.toast("Nam din."); return; }
                Map<String, Object> c = new LinkedHashMap<String, Object>();
                c.put("id", Store.id());
                c.put("name", name.getText().toString().trim());
                c.put("contact", person.getText().toString().trim());
                c.put("phone", phone.getText().toString().trim());
                c.put("address", addr.getText().toString().trim());
                store.list("suppliers").add(c);
                s.afterSave("Supplier save hoyeche.");
            }
        });
        form.addView(save);
        body.addView(form);

        LinearLayout list = Ui.card(s.act, "Supplier list o payable");
        list.addView(Ui.cells(s.act,
            new String[]{"SUPPLIER", "PHONE", "PURCHASED", "PAYABLE"},
            new float[]{3.4f, 2.4f, 2.2f, 2.2f}, Ui.NAVY, true));
        list.addView(Ui.divider(s.act));
        for (Object o : store.list("suppliers")) {
            Map<String, Object> sup = Store.rec(o);
            String sid = Store.str(sup, "id");
            double bought = 0, pay = 0;
            for (Object po : store.list("purchases")) {
                Map<String, Object> p = Store.rec(po);
                if (sid.equals(Store.str(p, "supplierId"))
                        || (!Store.str(p, "supplierName").isEmpty()
                            && Store.str(p, "supplierName").equals(Store.str(sup, "name")))) {
                    bought += Store.num(p.get("subtotal"));
                    pay += Store.num(p.get("due"));
                }
            }
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(sup, "name"), Store.str(sup, "phone"),
                             Ui.money(bought), Ui.money(pay)},
                new float[]{3.4f, 2.4f, 2.2f, 2.2f}, pay > 0 ? Ui.RED : Ui.TEXT, false));
        }
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    /* ============================ purchases ============================ */

    static View purchases(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);
        LinearLayout form = Ui.card(s.act, "Purchase");
        final EditText no = Ui.field(s.act, "Purchase No.", store.nextPurchaseNo(),
                InputType.TYPE_CLASS_TEXT);
        final EditText date = s.dateField(Store.today(), "Date");
        final EditText supplier = Ui.field(s.act, "Supplier Name", "", InputType.TYPE_CLASS_TEXT);
        final EditText product = Ui.field(s.act, "Product name (existing or new)",
                "", InputType.TYPE_CLASS_TEXT);
        final EditText qty = Ui.number(s.act, "Qty", "");
        final EditText cost = Ui.number(s.act, "Unit Cost (\u09F3)", "");
        final EditText paid = Ui.number(s.act, "Paid Now (\u09F3)", "");
        final EditText note = Ui.field(s.act, "Note", "", InputType.TYPE_CLASS_TEXT);
        form.addView(Ui.label(s.act, "Purchase No.")); form.addView(no);
        form.addView(Ui.label(s.act, "Date")); form.addView(date);
        form.addView(Ui.label(s.act, "Supplier")); form.addView(supplier);
        form.addView(Ui.label(s.act, "Product")); form.addView(product);
        form.addView(Ui.label(s.act, "Qty")); form.addView(qty);
        form.addView(Ui.label(s.act, "Unit Cost (\u09F3)")); form.addView(cost);
        form.addView(Ui.label(s.act, "Paid Now (\u09F3)")); form.addView(paid);
        form.addView(Ui.label(s.act, "Note")); form.addView(note);
        Button save = Ui.primary(s.act, "Save Purchase");
        save.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String pname = product.getText().toString().trim();
                double q = Store.num(qty.getText().toString());
                if (pname.isEmpty() || q <= 0) { s.toast("Product ar qty din."); return; }
                // A purchase may name a product that does not exist yet: buying it is
                // exactly the moment it becomes real, so it is created here.
                Map<String, Object> p = null;
                for (Object o : store.list("products")) {
                    if (Store.str(o, "name").equalsIgnoreCase(pname)) { p = Store.rec(o); break; }
                }
                if (p == null) {
                    p = new LinkedHashMap<String, Object>();
                    p.put("id", Store.id());
                    p.put("name", pname);
                    p.put("sku", "");
                    p.put("category", "General");
                    p.put("unit", "pcs");
                    p.put("cost", Double.valueOf(Store.num(cost.getText().toString())));
                    p.put("rate", Double.valueOf(Store.num(cost.getText().toString())));
                    p.put("vat", Double.valueOf(0));
                    p.put("reorderLevel", Double.valueOf(10));
                    store.list("products").add(p);
                }
                Map<String, Object> it = new LinkedHashMap<String, Object>();
                it.put("productId", Store.str(p, "id"));
                it.put("qty", Double.valueOf(q));
                it.put("cost", Double.valueOf(Store.num(cost.getText().toString())));
                it.put("amount", Double.valueOf(Store.round2(q * Store.num(cost.getText().toString()))));
                List<Object> items = new ArrayList<Object>();
                items.add(it);

                Map<String, Object> pu = new LinkedHashMap<String, Object>();
                pu.put("id", Store.id());
                pu.put("purchaseNo", no.getText().toString().trim());
                pu.put("date", date.getText().toString());
                pu.put("supplierId", "");
                pu.put("supplierName", supplier.getText().toString().trim());
                pu.put("items", items);
                double subtotal = Store.round2(q * Store.num(cost.getText().toString()));
                double paidNow = Math.min(subtotal, Math.max(0, Store.num(paid.getText().toString())));
                pu.put("subtotal", Double.valueOf(subtotal));
                pu.put("paid", Double.valueOf(paidNow));
                pu.put("due", Double.valueOf(Store.round2(subtotal - paidNow)));
                pu.put("note", note.getText().toString().trim());

                store.list("purchases").add(pu);
                store.map("seq").put("purchase", Long.valueOf((long) Store.num(store.map("seq").get("purchase")) + 1));
                store.applyPurchaseToStock(pu);
                s.afterSave("Purchase save hoyeche, stock barche.");
            }
        });
        form.addView(save);
        body.addView(form);

        LinearLayout list = Ui.card(s.act, "Purchase History");
        for (int i = store.list("purchases").size() - 1; i >= 0; i--) {
            Map<String, Object> p = Store.rec(store.list("purchases").get(i));
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(p, "purchaseNo"), Ui.money(p.get("subtotal"))},
                new float[]{3f, 2f}, Ui.NAVY, true));
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(p, "date"), Store.str(p, "supplierName"),
                             "Due " + Ui.money(p.get("due"))},
                new float[]{2.2f, 3f, 2.4f}, Ui.MUTED, false));
            list.addView(Ui.divider(s.act));
        }
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    /* ============================ delivery ============================ */

    static View delivery(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);
        body.addView(Ui.label(s.act, "Memo select korle update form khulbe."));

        LinearLayout list = Ui.card(s.act, "Delivery Tracking");
        for (Object o : store.list("deliveries")) {
            Map<String, Object> d = Store.rec(o);
            double left = Store.num(d.get("qty")) - Store.num(d.get("delivered"));
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(d, "memoNo"), Store.str(d, "date"),
                             Ui.qty(left) + " baki"},
                new float[]{3f, 2.4f, 2.4f}, left > 0 ? Ui.AMBER : Ui.GREEN, true));
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(d, "receiver"), Store.str(d, "driver"),
                             Store.str(d, "vehicle")},
                new float[]{3f, 3f, 2.4f}, Ui.MUTED, false));
        }
        if (store.list("deliveries").isEmpty()) {
            list.addView(Ui.label(s.act, "Ekhono delivery nei."));
        }
        body.addView(list);

        /* Parcels coming back. Kept apart from delivery on purpose: the owner needs
           to see what went out and what came back as two separate books. */
        LinearLayout rets = Ui.card(s.act, "Parcel Return");
        rets.addView(Ui.cells(s.act, new String[]{"MEMO", "DATE", "QTY", "CONDITION"},
            new float[]{3f, 2.4f, 1.6f, 2.6f}, Ui.NAVY, true));
        for (Object o : store.list("returns")) {
            final Map<String, Object> r = Store.rec(o);
            rets.addView(Ui.cells(s.act,
                new String[]{Store.str(r, "memoNo"), Store.str(r, "date"),
                             Ui.qty(r.get("qty")), Store.str(r, "condition")},
                new float[]{3f, 2.4f, 1.6f, 2.6f},
                "good".equals(Store.str(r, "condition")) ? Ui.GREEN : Ui.AMBER, true));
            LinearLayout line = Ui.row(s.act);
            line.addView(Ui.label(s.act, Store.str(r, "note")));
            Button del = Ui.ghost(s.act, "Delete");
            del.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    store.reverseReturnFromStock(r);
                    store.list("returns").remove(r);
                    s.afterSave("Return delete hoyeche, stock thik kora hoyeche.");
                }
            });
            line.addView(del);
            rets.addView(line);
        }
        if (store.list("returns").isEmpty()) {
            rets.addView(Ui.label(s.act, "Ekhono return nei."));
        }
        body.addView(rets);

        /* Enter a return for any memo that still has something with the customer. */
        final List<String> rMemoIds = new ArrayList<String>();
        final List<String> rMemoNos = new ArrayList<String>();
        for (Object o : store.list("memos")) {
            Map<String, Object> m = Store.rec(o);
            if (store.pendingQtyOf(m) > 0) {
                rMemoIds.add(Store.str(m, "id"));
                rMemoNos.add(Store.str(m, "memoNo") + " \u2022 " + Store.str(m, "customerName")
                    + " \u2022 " + Ui.qty(store.pendingQtyOf(m)) + " baki");
            }
        }
        if (!rMemoIds.isEmpty()) {
            LinearLayout addR = Ui.card(s.act, "+ Parcel Return");
            final int[] chosen = {0};
            final Button rpicker = Ui.ghost(s.act, rMemoNos.get(0));
            final EditText rqty = Ui.number(s.act, "Return Qty", "");
            final EditText rnote = Ui.field(s.act, "Note (kotha theke firse)", "", InputType.TYPE_CLASS_TEXT);
            final String[] conditions = {"good", "damaged"};
            final String[] condition = {"good"};
            final Button rcond = Ui.ghost(s.act, "Condition: Good");
            rpicker.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    s.choose("Memo bachun", rMemoNos, new Screens.OnText() {
                        public void on(String idx) {
                            chosen[0] = (int) Store.num(idx);
                            rpicker.setText(rMemoNos.get(chosen[0]));
                            Map<String, Object> m = ScreensData.findMemo(store, rMemoIds.get(chosen[0]));
                            rqty.setText(Ui.qty(store.pendingQtyOf(m)));
                        }
                    });
                }
            });
            rcond.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    s.choose("Condition bachun", new ArrayList<String>(java.util.Arrays.asList(conditions)),
                        new Screens.OnText() {
                            public void on(String idx) {
                                condition[0] = conditions[(int) Store.num(idx)];
                                rcond.setText("Condition: " + ("good".equals(condition[0]) ? "Good" : "Damaged"));
                            }
                        });
                }
            });
            Button rsave = Ui.primary(s.act, "Save Return");
            rsave.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    Map<String, Object> m = ScreensData.findMemo(store, rMemoIds.get(chosen[0]));
                    if (m == null) { s.afterSave("Memo pawa jay ni."); return; }
                    double q = Store.num(rqty.getText().toString());
                    double pend = store.pendingQtyOf(m);
                    if (q <= 0) { s.afterSave("Return qty din."); return; }
                    if (q > pend) { s.afterSave("Return qty baki " + Ui.qty(pend) + "-er beshi hote pare na."); return; }
                    Map<String, Object> r = new LinkedHashMap<String, Object>();
                    r.put("id", Store.id());
                    r.put("memoId", Store.str(m, "id"));
                    r.put("memoNo", Store.str(m, "memoNo"));
                    r.put("customerName", Store.str(m, "customerName"));
                    r.put("date", Store.today());
                    r.put("qty", Double.valueOf(q));
                    r.put("condition", condition[0]);
                    r.put("note", rnote.getText().toString().trim());
                    /* Per-product lines, so stock rises for the right products even
                       when only some lines of a memo came back. */
                    List<Object> lines = new ArrayList<Object>();
                    double left = q;
                    for (Object io : Json.arr(m.get("items"))) {
                        Map<String, Object> it = Store.rec(io);
                        double take = Math.min(left, Store.num(it.get("qty")));
                        if (take <= 0) break;
                        Map<String, Object> ln = new LinkedHashMap<String, Object>();
                        ln.put("productId", Store.str(it, "productId"));
                        ln.put("productName", Store.str(it, "productName"));
                        ln.put("qty", Double.valueOf(take));
                        lines.add(ln);
                        left -= take;
                    }
                    r.put("lines", lines);
                    store.saveReturn(r);
                    s.afterSave("Return save hoyeche" +
                        ("good".equals(condition[0]) ? ", stock-e jog hoyeche." : ", stock-e jog hoy ni (damaged)."));
                }
            });
            addR.addView(rpicker);
            addR.addView(Ui.label(s.act, "Return Qty")); addR.addView(rqty);
            addR.addView(rcond);
            addR.addView(Ui.label(s.act, "Note")); addR.addView(rnote);
            addR.addView(rsave);
            body.addView(addR);
        }

        // Create a delivery for a memo that has none yet.
        final List<String> memoNos = new ArrayList<String>();
        final List<String> memoIds = new ArrayList<String>();
        for (Object o : store.list("memos")) {
            Map<String, Object> m = Store.rec(o);
            boolean has = false;
            for (Object dro : store.list("deliveries")) {
                if (Store.str(dro, "memoNo").equals(Store.str(m, "memoNo"))) { has = true; break; }
            }
            if (!has) {
                memoIds.add(Store.str(m, "id"));
                memoNos.add(Store.str(m, "memoNo") + " \u2022 " + Store.str(m, "customerName"));
            }
        }
        if (!memoIds.isEmpty()) {
            LinearLayout add = Ui.card(s.act, "+ Delivery for a memo");
            final int[] chosen = {0};
            final Button picker = Ui.ghost(s.act, memoNos.get(0));
            final EditText qty = Ui.number(s.act, "Delivery Qty", "");
            final EditText driver = Ui.field(s.act, "Driver Name", "", InputType.TYPE_CLASS_TEXT);
            final EditText vehicle = Ui.field(s.act, "Vehicle / Truck No", "", InputType.TYPE_CLASS_TEXT);
            final EditText receiver = Ui.field(s.act, "Receiver Name", "", InputType.TYPE_CLASS_TEXT);
            picker.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    s.choose("Memo bachun", memoNos, new Screens.OnText() {
                        public void on(String idx) {
                            chosen[0] = (int) Store.num(idx);
                            picker.setText(memoNos.get(chosen[0]));
                            Map<String, Object> m = ScreensData.findMemo(store, memoIds.get(chosen[0]));
                            if (m != null) {
                                double tot = 0;
                                for (Object io : Json.arr(m.get("items"))) tot += Store.num(Store.rec(io).get("qty"));
                                qty.setText(Ui.qty(tot));
                            }
                        }
                    });
                }
            });
            add.addView(picker);
            add.addView(Ui.label(s.act, "Delivery Qty")); add.addView(qty);
            add.addView(Ui.label(s.act, "Driver")); add.addView(driver);
            add.addView(Ui.label(s.act, "Vehicle")); add.addView(vehicle);
            add.addView(Ui.label(s.act, "Receiver")); add.addView(receiver);
            Button save = Ui.primary(s.act, "Save Delivery");
            save.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) {
                    Map<String, Object> m = ScreensData.findMemo(store, memoIds.get(chosen[0]));
                    Map<String, Object> d = new LinkedHashMap<String, Object>();
                    d.put("id", Store.id());
                    d.put("memoId", memoIds.get(chosen[0]));
                    d.put("memoNo", m == null ? "" : Store.str(m, "memoNo"));
                    d.put("customerName", m == null ? "" : Store.str(m, "customerName"));
                    d.put("date", Store.today());
                    d.put("qty", Double.valueOf(Store.num(qty.getText().toString())));
                    d.put("delivered", Double.valueOf(0));
                    d.put("driver", driver.getText().toString().trim());
                    d.put("vehicle", vehicle.getText().toString().trim());
                    d.put("receiver", receiver.getText().toString().trim());
                    store.list("deliveries").add(d);
                    s.afterSave("Delivery add hoyeche.");
                }
            });
            add.addView(save);
            body.addView(add);
        }
        return Ui.scroller(s.act, body);
    }

    /* ============================ profit by item ============================ */

    static View profitByItem(final Screens s) {
        LinearLayout body = Ui.col(s.act);
        LinearLayout list = Ui.card(s.act, "Profit / Item");
        list.addView(Ui.cells(s.act,
            new String[]{"PRODUCT", "QTY", "SALES", "COST", "PROFIT"},
            new float[]{3.4f, 1.2f, 2f, 2f, 2f}, Ui.NAVY, true));
        list.addView(Ui.divider(s.act));
        Map<String, double[]> byProduct = new LinkedHashMap<String, double[]>();
        for (Object o : s.store.list("memos")) {
            for (Object io : Json.arr(Store.rec(o).get("items"))) {
                Map<String, Object> it = Store.rec(io);
                String pid = Store.str(it, "productId");
                double[] t = byProduct.get(pid);
                if (t == null) { t = new double[3]; byProduct.put(pid, t); }
                t[0] += Store.num(it.get("qty"));
                t[1] += Store.num(it.get("amount"));
                t[2] += Store.num(it.get("qty")) * Store.num(it.get("cost"));
            }
        }
        double totProfit = 0;
        for (Map.Entry<String, double[]> e : byProduct.entrySet()) {
            Map<String, Object> p = s.store.productById(e.getKey());
            double[] t = e.getValue();
            double profit = t[1] - t[2];
            totProfit += profit;
            list.addView(Ui.cells(s.act,
                new String[]{p == null ? "(deleted)" : Store.str(p, "name"),
                             Ui.qty(t[0]), Ui.money(t[1]), Ui.money(t[2]), Ui.money(profit)},
                new float[]{3.4f, 1.2f, 2f, 2f, 2f}, profit >= 0 ? Ui.GREEN : Ui.RED, false));
        }
        if (byProduct.isEmpty()) list.addView(Ui.label(s.act, "Kono memo nei."));
        list.addView(Ui.divider(s.act));
        list.addView(Ui.cells(s.act, new String[]{"Total", "", "", "", Ui.money(totProfit)},
                new float[]{3.4f, 1.2f, 2f, 2f, 2f}, Ui.NAVY, true));
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    /* ============================ P&L ============================ */

    static View profitAndLoss(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);

        LinearLayout range = Ui.card(s.act, "Range");
        final EditText from = s.dateField(Store.today().substring(0, 8) + "01", "From");
        final EditText to = s.dateField(Store.today(), "To");
        range.addView(Ui.label(s.act, "From")); range.addView(from);
        range.addView(Ui.label(s.act, "To")); range.addView(to);
        final LinearLayout out = Ui.card(s.act, "P&L Statement");
        Button run = Ui.primary(s.act, "Hisab dekhan");
        run.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                out.removeAllViews();
                showPl(store, out, from.getText().toString(), to.getText().toString());
            }
        });
        range.addView(run);
        body.addView(range);
        showPl(store, out, Store.today().substring(0, 8) + "01", Store.today());
        body.addView(out);

        LinearLayout months = Ui.card(s.act, "Month-wise");
        for (int i = 5; i >= 0; i--) {
            java.util.Calendar c = java.util.Calendar.getInstance();
            c.add(java.util.Calendar.MONTH, -i);
            String mFrom = String.format(Locale.US, "%04d-%02d-01",
                    c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH) + 1);
            String mTo = String.format(Locale.US, "%04d-%02d-31",
                    c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH) + 1);
            Map<String, Object> pl = store.plSummary(mFrom, mTo);
            months.addView(Ui.cells(s.act,
                new String[]{mFrom.substring(0, 7), Ui.money(pl.get("sales")),
                             Ui.money(pl.get("grossProfit")), Ui.money(pl.get("netProfit"))},
                new float[]{1.6f, 2f, 2f, 2f}, Ui.TEXT, false));
        }
        months.addView(Ui.label(s.act, "Month \u2022 Sales \u2022 Gross \u2022 Net"));
        body.addView(months);
        return Ui.scroller(s.act, body);
    }

    private static void showPl(Store store, LinearLayout into, String from, String to) {
        Map<String, Object> pl = store.plSummary(from, to);
        row(into, from + " \u2192 " + to);
        row(into, "Sales", Ui.money(pl.get("sales")));
        row(into, "Discount", Ui.money(pl.get("discount")));
        row(into, "COGS", Ui.money(pl.get("cogs")));
        row(into, "Gross profit", Ui.money(pl.get("grossProfit")));
        row(into, "Delivery income", Ui.money(pl.get("deliveryIncome")));
        row(into, "VAT collected", Ui.money(pl.get("vatCollected")));
        row(into, "Expense", Ui.money(pl.get("expense")));
        row(into, "NET PROFIT", Ui.money(pl.get("netProfit")));
    }

    private static void row(LinearLayout into, String k) { row(into, k, ""); }

    private static void row(LinearLayout into, String k, String v) {
        LinearLayout r = Ui.row(into.getContext());
        TextView a = new TextView(into.getContext());
        a.setText(k);
        a.setTextSize(12.5f);
        a.setTextColor(Ui.MUTED);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 2f);
        a.setLayoutParams(lp);
        TextView b = new TextView(into.getContext());
        b.setText(v);
        b.setTextSize(12.5f);
        b.setTextColor(Ui.TEXT);
        b.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 2f));
        r.addView(a);
        r.addView(b);
        into.addView(r);
    }

    /* ============================ ageing ============================ */

    static View ageing(final Screens s) {
        LinearLayout body = Ui.col(s.act);
        LinearLayout rec = Ui.card(s.act, "Receivable \u2014 Customer-wise Ageing");
        rec.addView(Ui.cells(s.act,
            new String[]{"CUSTOMER", "0-30", "31-60", "61-90", "90+"},
            new float[]{3f, 2f, 2f, 2f, 2f}, Ui.NAVY, true));
        rec.addView(Ui.divider(s.act));
        Map<String, List<Object>> byCustomer = new LinkedHashMap<String, List<Object>>();
        for (Object o : s.store.list("memos")) {
            Map<String, Object> m = Store.rec(o);
            String k = Store.str(m, "customerName");
            if (k.isEmpty()) k = "(no name)";
            List<Object> l = byCustomer.get(k);
            if (l == null) { l = new ArrayList<Object>(); byCustomer.put(k, l); }
            l.add(m);
        }
        for (Map.Entry<String, List<Object>> e : byCustomer.entrySet()) {
            Map<String, Object> b = s.store.ageingBuckets(e.getValue(), Store.today());
            if (Store.num(b.get("total")) <= 0) continue;
            rec.addView(Ui.cells(s.act,
                new String[]{e.getKey(), Ui.money(b.get("current")), Ui.money(b.get("d30")),
                             Ui.money(b.get("d60")), Ui.money(b.get("over90"))},
                new float[]{3f, 2f, 2f, 2f, 2f}, Ui.AMBER, false));
        }
        body.addView(rec);

        LinearLayout pay = Ui.card(s.act, "Payable \u2014 Supplier-wise");
        Map<String, Double> bySupplier = new LinkedHashMap<String, Double>();
        for (Object o : s.store.list("purchases")) {
            Map<String, Object> p = Store.rec(o);
            String k = Store.str(p, "supplierName");
            if (k.isEmpty()) k = "(no supplier)";
            Double prev = bySupplier.get(k);
            bySupplier.put(k, (prev == null ? 0 : prev) + Store.num(p.get("due")));
        }
        for (Map.Entry<String, Double> e : bySupplier.entrySet()) {
            pay.addView(Ui.cells(s.act, new String[]{e.getKey(), Ui.money(e.getValue())},
                new float[]{3f, 2f}, e.getValue() > 0 ? Ui.RED : Ui.TEXT, false));
        }
        if (bySupplier.isEmpty()) pay.addView(Ui.label(s.act, "Kono purchase nei."));
        body.addView(pay);
        return Ui.scroller(s.act, body);
    }

    /* ============================ expenses ============================ */

    static View expenses(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);
        LinearLayout form = Ui.card(s.act, "Expense");
        final EditText date = s.dateField(Store.today(), "Date");
        final String[] heads = {"Rent", "Salary", "Utility Bill", "Transport",
                                "Packaging", "Marketing", "Office", "Other"};
        final int[] head = {0};
        final Button headBtn = Ui.ghost(s.act, heads[0]);
        headBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                List<String> l = new ArrayList<String>();
                for (String h : heads) l.add(h);
                s.choose("Expense head", l, new Screens.OnText() {
                    public void on(String idx) {
                        head[0] = (int) Store.num(idx);
                        headBtn.setText(heads[head[0]]);
                    }
                });
            }
        });
        final EditText amount = Ui.number(s.act, "Amount (\u09F3)", "");
        final EditText note = Ui.field(s.act, "Note", "", InputType.TYPE_CLASS_TEXT);
        form.addView(Ui.label(s.act, "Date")); form.addView(date);
        form.addView(Ui.label(s.act, "Expense Head")); form.addView(headBtn);
        form.addView(Ui.label(s.act, "Amount (\u09F3)")); form.addView(amount);
        form.addView(Ui.label(s.act, "Note")); form.addView(note);
        Button save = Ui.primary(s.act, "Save Expense");
        save.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                double amt = Store.num(amount.getText().toString());
                if (amt <= 0) { s.toast("Amount din."); return; }
                Map<String, Object> e = new LinkedHashMap<String, Object>();
                e.put("id", Store.id());
                e.put("date", date.getText().toString());
                e.put("head", heads[head[0]]);
                e.put("amount", Double.valueOf(amt));
                e.put("note", note.getText().toString().trim());
                store.list("expenses").add(e);
                s.afterSave("Expense save hoyeche.");
            }
        });
        form.addView(save);
        body.addView(form);

        LinearLayout list = Ui.card(s.act, "Expense list");
        double total = 0;
        for (Object o : store.list("expenses")) {
            Map<String, Object> e = Store.rec(o);
            total += Store.num(e.get("amount"));
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(e, "date"), Store.str(e, "head"),
                             Ui.money(e.get("amount"))},
                new float[]{2.4f, 3f, 2f}, Ui.TEXT, false));
        }
        list.addView(Ui.divider(s.act));
        list.addView(Ui.cells(s.act, new String[]{"Total expense", "", Ui.money(total)},
                new float[]{2.4f, 3f, 2f}, Ui.NAVY, true));
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    /* ============================ users ============================ */

    static View users(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);
        LinearLayout form = Ui.card(s.act, "Users & Roles");
        final EditText un = Ui.field(s.act, "Username", "", InputType.TYPE_CLASS_TEXT);
        final EditText nm = Ui.field(s.act, "Full Name", "", InputType.TYPE_CLASS_TEXT);
        final EditText pw = Ui.field(s.act, "Password", "", InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        final String[] roles = {"admin", "manager", "salesman", "accountant"};
        final int[] role = {2};
        final Button roleBtn = Ui.ghost(s.act, "Salesman \u2014 memo o delivery");
        roleBtn.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                s.choose("Role", new ArrayList<String>(java.util.Arrays.asList(roles)),
                    new Screens.OnText() {
                        public void on(String idx) {
                            role[0] = (int) Store.num(idx);
                            roleBtn.setText(roles[role[0]]);
                        }
                    });
            }
        });
        form.addView(Ui.label(s.act, "Username")); form.addView(un);
        form.addView(Ui.label(s.act, "Full Name")); form.addView(nm);
        form.addView(Ui.label(s.act, "Password")); form.addView(pw);
        form.addView(Ui.label(s.act, "Role")); form.addView(roleBtn);
        Button add = Ui.primary(s.act, "Add User");
        add.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String u = un.getText().toString().trim();
                String p = pw.getText().toString();
                if (u.isEmpty() || p.isEmpty()) { s.toast("Username ar password din."); return; }
                for (Object o : store.list("users")) {
                    if (Store.str(o, "username").equals(u)) {
                        s.toast("Ei username age ache.");
                        return;
                    }
                }
                Map<String, Object> nuser = new LinkedHashMap<String, Object>();
                nuser.put("id", Store.id());
                nuser.put("username", u);
                nuser.put("name", nm.getText().toString().trim().isEmpty()
                        ? u : nm.getText().toString().trim());
                nuser.put("pass", Store.hash(p));
                nuser.put("role", roles[role[0]]);
                nuser.put("active", Boolean.TRUE);
                nuser.put("createdAt", Store.today());
                store.list("users").add(nuser);
                s.afterSave("User add hoyeche.");
            }
        });
        form.addView(add);
        body.addView(form);

        LinearLayout list = Ui.card(s.act, "User list");
        for (Object o : store.list("users")) {
            final Map<String, Object> u = Store.rec(o);
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(u, "username"), Store.str(u, "name"), Store.str(u, "role")},
                new float[]{2.4f, 3f, 2.4f}, Ui.TEXT, false));
            if (!"admin".equals(Store.str(u, "username"))) {
                Button del = Ui.ghost(s.act, "Delete " + Store.str(u, "username"));
                del.setTextColor(Ui.RED);
                del.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) {
                        s.confirm("User ta muchhe felben?", new Runnable() {
                            public void run() {
                                store.list("users").remove(u);
                                s.afterSave("User delete hoyeche.");
                            }
                        });
                    }
                });
                list.addView(del);
            }
        }
        body.addView(list);

        LinearLayout pass = Ui.card(s.act, "Change my password");
        final EditText oldP = Ui.field(s.act, "Current Password", "", InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        final EditText newP = Ui.field(s.act, "New Password", "", InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        pass.addView(oldP);
        pass.addView(newP);
        Button chg = Ui.primary(s.act, "Change");
        chg.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Map<String, Object> me = me(store);
                if (me == null) return;
                if (!Store.str(me, "pass").equals(Store.hash(oldP.getText().toString()))) {
                    s.toast("Purono password bhul.");
                    return;
                }
                if (newP.getText().toString().isEmpty()) { s.toast("Notun password din."); return; }
                me.put("pass", Store.hash(newP.getText().toString()));
                s.afterSave("Password bodlano hoyeche.");
            }
        });
        pass.addView(chg);
        body.addView(pass);
        return Ui.scroller(s.act, body);
    }

    static Map<String, Object> me(Store store) {
        if (store.session == null) return null;
        for (Object o : store.list("users")) {
            if (Store.str(o, "id").equals(Store.str(store.session, "userId"))) return Store.rec(o);
        }
        return null;
    }

    /* ============================ settings ============================ */

    static View settings(final Screens s) {
        final Store store = s.store;
        final Map<String, Object> set = store.settings();
        final Map<String, Object> comp = store.company();
        LinearLayout body = Ui.col(s.act);

        LinearLayout form = Ui.card(s.act, "Company (memo-te print hobe)");
        final EditText cName = Ui.field(s.act, "Company Name", Store.str(comp, "name"), InputType.TYPE_CLASS_TEXT);
        final EditText tag = Ui.field(s.act, "Tagline", Store.str(comp, "tagline"), InputType.TYPE_CLASS_TEXT);
        final EditText md = Ui.field(s.act, "Managing Director", Store.str(comp, "md"), InputType.TYPE_CLASS_TEXT);
        final EditText phone = Ui.field(s.act, "Phone", Store.str(comp, "phone"), InputType.TYPE_CLASS_PHONE);
        final EditText email = Ui.field(s.act, "Email", Store.str(comp, "email"), InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        final EditText addr = Ui.field(s.act, "Address", Store.str(comp, "address"), InputType.TYPE_CLASS_TEXT);
        final EditText bin = Ui.field(s.act, "BIN", Store.str(comp, "bin"), InputType.TYPE_CLASS_TEXT);
        final EditText vatReg = Ui.field(s.act, "VAT Reg No.", Store.str(comp, "vatReg"), InputType.TYPE_CLASS_TEXT);
        final EditText prefix = Ui.field(s.act, "Memo Prefix", Store.str(set, "memoPrefix"), InputType.TYPE_CLASS_TEXT);
        final EditText tagDev = Ui.field(s.act, "Device Tag (PC / PH)", Store.str(set, "deviceTag"), InputType.TYPE_CLASS_TEXT);
        final EditText low = Ui.number(s.act, "Default Low-Stock Level", Ui.qty(set.get("lowStockLevel")));
        form.addView(cName); form.addView(tag); form.addView(md); form.addView(phone);
        form.addView(email); form.addView(addr); form.addView(bin); form.addView(vatReg);
        form.addView(Ui.label(s.act, "Memo Prefix")); form.addView(prefix);
        form.addView(Ui.label(s.act, "Device Tag (PC / PH)")); form.addView(tagDev);
        form.addView(Ui.label(s.act, "Default Low-Stock Level")); form.addView(low);
        Button save = Ui.primary(s.act, "Save Settings");
        save.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                comp.put("name", cName.getText().toString().trim());
                comp.put("tagline", tag.getText().toString().trim());
                comp.put("md", md.getText().toString().trim());
                comp.put("phone", phone.getText().toString().trim());
                comp.put("email", email.getText().toString().trim());
                comp.put("address", addr.getText().toString().trim());
                comp.put("bin", bin.getText().toString().trim());
                comp.put("vatReg", vatReg.getText().toString().trim());
                set.put("company", comp);
                set.put("memoPrefix", prefix.getText().toString().trim());
                set.put("deviceTag", tagDev.getText().toString().trim());
                set.put("lowStockLevel", Double.valueOf(Store.num(low.getText().toString())));
                s.afterSave("Settings save hoyeche.");
            }
        });
        form.addView(save);
        body.addView(form);

        LinearLayout sync = Ui.card(s.act, "Google Sheets Sync");
        sync.addView(Ui.label(s.act,
            "Ei sync verify kore \u2014 response na pele \"synced\" bole na. Internet na thakle "
            + "ar pore pathano hoy."));
        final EditText url = Ui.field(s.act, "Apps Script Web App URL",
                Store.str(set, "syncUrl"), InputType.TYPE_TEXT_VARIATION_URI);
        sync.addView(url);
        Button saveUrl = Ui.ghost(s.act, "Save URL");
        saveUrl.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                set.put("syncUrl", url.getText().toString().trim());
                s.afterSave("Sync URL save hoyeche.");
            }
        });
        Button test = Ui.ghost(s.act, "Test Sync");
        test.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                final String u = url.getText().toString().trim();
                if (u.isEmpty()) { s.toast("Age sync URL din."); return; }
                set.put("syncUrl", u);
                store.commit();
                s.toast("Sync test pathano hoche...");
                new Thread(new Runnable() {
                    public void run() {
                        final String r = Sync.push(store, u);
                        s.act.runOnUiThread(new Runnable() {
                            public void run() { s.toast(r); }
                        });
                    }
                }).start();
            }
        });
        sync.addView(saveUrl);
        sync.addView(test);
        body.addView(sync);

        LinearLayout rule = Ui.card(s.act, "Stock Rule");
        rule.addView(Ui.label(s.act,
            "Memo-i ashol. Stock na thakleo memo save hobe \u2014 ar jei product memo-te "
            + "uthbe seta Stock page-e nijei bose jabe. Memo kokhono atkabe na."));
        body.addView(rule);

        LinearLayout about = Ui.card(s.act, "App");
        about.addView(Ui.cells(s.act, new String[]{"Version", MainActivity.APP_VERSION},
                new float[]{2f, 2f}, Ui.TEXT, false));
        about.addView(Ui.cells(s.act, new String[]{"Device", store.deviceTag()},
                new float[]{2f, 2f}, Ui.TEXT, false));
        body.addView(about);

        return Ui.scroller(s.act, body);
    }

    /* ============================ backup ============================ */

    static View backup(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);

        LinearLayout b = Ui.card(s.act, "Backup & Restore");
        b.addView(Ui.label(s.act,
            "Data apnar phone-e (app-er private folder-e) thake. Cloud backup thakle "
            + "PC/phone hariye gele sekhan theke sob fire asha jabe."));
        Button file = Ui.ghost(s.act, "Backup file likhun");
        file.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String path = MainActivity.writeBackup(store);
                s.toast(path == null ? "Backup likhte parlam na."
                        : "Backup likha hoyeche:\n" + path);
            }
        });
        Button restore = Ui.ghost(s.act, "Latest safety copy fire aan");
        restore.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                final List<Object> snaps = MainActivity.listSnapshots(store);
                if (snaps.isEmpty()) { s.toast("Kono snapshot nei."); return; }
                List<String> labels = new ArrayList<String>();
                for (Object o : snaps) {
                    labels.add(String.valueOf(Store.rec(o).get("sig")) + " @ "
                            + new java.text.SimpleDateFormat("dd/MM HH:mm", Locale.US)
                                .format(new java.util.Date((long) Store.num(Store.rec(o).get("at")))));
                }
                s.choose("Snapshot restore", labels, new Screens.OnText() {
                    public void on(String idx) {
                        final int i = (int) Store.num(idx);
                        s.confirm("Snapshot ta restore korben? Ekhonkar data replace hobe.",
                            new Runnable() {
                                public void run() {
                                    String r = MainActivity.restoreSnapshot(store, i);
                                    s.toast(r);
                                    s.render();
                                }
                            });
                    }
                });
            }
        });
        b.addView(file);
        b.addView(restore);
        body.addView(b);

        LinearLayout cloud = Ui.card(s.act, "Cloud Backup & Restore");
        cloud.addView(Ui.label(s.act,
            "Ei phone-er pura data Google Sheet-e ek row hisebe rakha jay, ar "
            + "onno device-er data ekhane nijei chole ashe."));
        Button push = Ui.primary(s.act, "Cloud-e backup pathaan");
        push.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String url = Store.str(store.settings(), "syncUrl");
                if (url.isEmpty()) { s.toast("Age Settings-e sync URL bosan."); return; }
                s.toast("Pathano hoche...");
                new Thread(new Runnable() {
                    public void run() {
                        final String r = Sync.backup(store, url);
                        s.act.runOnUiThread(new Runnable() {
                            public void run() { s.toast(r); }
                        });
                    }
                }).start();
            }
        });
        Button pull = Ui.ghost(s.act, "Sheet theke sob data merge korun");
        pull.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String url = Store.str(store.settings(), "syncUrl");
                if (url.isEmpty()) { s.toast("Age Settings-e sync URL bosan."); return; }
                s.toast("Sheet theke anaa hoche...");
                new Thread(new Runnable() {
                    public void run() {
                        final String r = Sync.pullAll(store, url);
                        s.act.runOnUiThread(new Runnable() {
                            public void run() { s.toast(r); s.render(); }
                        });
                    }
                }).start();
            }
        });
        cloud.addView(push);
        cloud.addView(pull);
        body.addView(cloud);

        LinearLayout sum = Ui.card(s.act, "Data Summary");
        sum.addView(Ui.cells(s.act, new String[]{"Products", String.valueOf(store.list("products").size())},
                new float[]{2f, 2f}, Ui.TEXT, false));
        sum.addView(Ui.cells(s.act, new String[]{"Customers", String.valueOf(store.list("customers").size())},
                new float[]{2f, 2f}, Ui.TEXT, false));
        sum.addView(Ui.cells(s.act, new String[]{"Memos", String.valueOf(store.list("memos").size())},
                new float[]{2f, 2f}, Ui.TEXT, false));
        sum.addView(Ui.cells(s.act, new String[]{"Purchases", String.valueOf(store.list("purchases").size())},
                new float[]{2f, 2f}, Ui.TEXT, false));
        sum.addView(Ui.cells(s.act, new String[]{"Stock movements", String.valueOf(store.list("ledger").size())},
                new float[]{2f, 2f}, Ui.TEXT, false));
        body.addView(sum);

        return Ui.scroller(s.act, body);
    }
}
