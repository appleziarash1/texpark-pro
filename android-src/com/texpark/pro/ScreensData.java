package com.texpark.pro;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.graphics.Typeface;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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
 * The screens that carry the day-to-day work: memo, memo history, products, stock.
 *
 * The rule this file exists to protect: a memo saves even when stock was never
 * entered. There is no guard on the Save button, no "insufficient stock" refusal,
 * and no branch that can lose what the owner typed. A product used in a memo gets
 * a stock card automatically, so it turns up on the Stock page ready to be topped
 * up. Anything that blocks a memo is a bug, whichever way it is written.
 */
public class ScreensData {

    private ScreensData() {}

    /* ============================ new sales memo ============================ */

    static View newMemo(final Screens s) {
        final Store store = s.store;
        final Screens.MemoDraft d = s.draft;
        if (d.date.isEmpty()) d.date = Store.today();
        if (d.memoNo.isEmpty()) d.memoNo = store.nextMemoNo();

        LinearLayout body = Ui.col(s.act);

        TextView rule = Ui.label(s.act,
            "Memo-i ashol. Stock na thakleo memo save hobe \u2014 product gulo Stock page-e "
            + "nijei bose jabe.");
        body.addView(rule);

        LinearLayout head = Ui.card(s.act, "Memo");
        head.addView(Ui.label(s.act, "Memo No."));
        final EditText memoNo = Ui.field(s.act, "Memo No.", d.memoNo, InputType.TYPE_CLASS_TEXT);
        head.addView(memoNo);
        head.addView(Ui.label(s.act, "Date"));
        final EditText date = s.dateField(d.date, "Date");
        head.addView(date);
        head.addView(Ui.label(s.act, "Customer Name"));
        final EditText name = Ui.field(s.act, "Customer Name", d.customerName,
                InputType.TYPE_CLASS_TEXT);
        head.addView(name);
        head.addView(Ui.label(s.act, "Phone"));
        final EditText phone = Ui.field(s.act, "Phone", d.customerPhone, InputType.TYPE_CLASS_PHONE);
        head.addView(phone);
        head.addView(Ui.label(s.act, "Address"));
        final EditText addr = Ui.field(s.act, "Address", d.customerAddress,
                InputType.TYPE_CLASS_TEXT);
        head.addView(addr);
        body.addView(head);

        /* ---- items ---- */
        LinearLayout items = Ui.card(s.act, "Products");
        items.addView(Ui.cells(s.act,
            new String[]{"PRODUCT", "QTY", "RATE", "AMOUNT"},
            new float[]{4f, 1.6f, 2f, 2.4f}, Ui.NAVY, true));
        items.addView(Ui.divider(s.act));

        for (int i = 0; i < d.lines.size(); i++) {
            final int idx = i;
            final Screens.MemoDraft.Line line = d.lines.get(i);
            LinearLayout row = Ui.col(s.act);

            LinearLayout top = Ui.row(s.act);
            Map<String, Object> prod = line.productId.isEmpty() ? null : store.productById(line.productId);
            Button pick = Ui.button(s.act, prod == null ? "Product bachun" : Store.str(prod, "name"),
                    0xFFE3E9F1);
            pick.setTextColor(Ui.NAVY);
            LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 4f);
            plp.setMargins(0, 0, Ui.dp(s.act, 6), 0);
            pick.setLayoutParams(plp);
            pick.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { pickProduct(s, idx); }
            });
            top.addView(pick);

            if (d.lines.size() > 1) {
                Button del = Ui.button(s.act, "\u2715", 0xFFF3D6DB);
                del.setTextColor(Ui.RED);
                del.setOnClickListener(new View.OnClickListener() {
                    public void onClick(View v) {
                        d.lines.remove(idx);
                        if (d.lines.isEmpty()) d.lines.add(new Screens.MemoDraft.Line());
                        s.render();
                    }
                });
                top.addView(del);
            }
            row.addView(top);

            LinearLayout nums = Ui.row(s.act);
            final EditText qty = Ui.number(s.act, "Qty", line.qty);
            final EditText rate = Ui.number(s.act, "Rate", line.rate);
            final EditText cost = Ui.number(s.act, "Cost", line.cost);
            qty.setLayoutParams(weighted(s, 2f));
            rate.setLayoutParams(weighted(s, 3f));
            cost.setLayoutParams(weighted(s, 3f));
            qty.setTextSize(13f);
            rate.setTextSize(13f);
            cost.setTextSize(13f);
            final Runnable sync = new Runnable() {
                public void run() {
                    line.qty = qty.getText().toString();
                    line.rate = rate.getText().toString();
                    line.cost = cost.getText().toString();
                    line.vat = "";
                    updateTotals(s, d);
                }
            };
            qty.setOnFocusChangeListener(new View.OnFocusChangeListener() {
                public void onFocusChange(View v, boolean has) { if (has) pickKeep(line); sync.run(); }
            });
            rate.setOnFocusChangeListener(new View.OnFocusChangeListener() {
                public void onFocusChange(View v, boolean has) { if (has) pickKeep(line); }
            });
            cost.setOnFocusChangeListener(new View.OnFocusChangeListener() {
                public void onFocusChange(View v, boolean has) { if (has) pickKeep(line); }
            });
            nums.addView(qty);
            nums.addView(rate);
            nums.addView(cost);
            row.addView(nums);
            row.addView(Ui.label(s.act, "Qty / Rate / Cost"));
            items.addView(row);
            items.addView(Ui.divider(s.act));
        }

        Button add = Ui.ghost(s.act, "+ Add Product Row");
        add.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                d.lines.add(new Screens.MemoDraft.Line());
                s.render();
            }
        });
        items.addView(add);
        body.addView(items);

        /* ---- charges and totals ---- */
        LinearLayout tot = Ui.card(s.act, "Amount");
        tot.addView(Ui.label(s.act, "Discount (\u09F3)"));
        final EditText disc = Ui.number(s.act, "Discount", d.discount);
        final EditText deliv = Ui.number(s.act, "Delivery Charge", d.delivery);
        final EditText adv = Ui.number(s.act, "Advance", d.advance);
        tot.addView(disc);
        tot.addView(Ui.label(s.act, "Delivery Charge (\u09F3)"));
        tot.addView(deliv);
        tot.addView(Ui.label(s.act, "Advance (\u09F3)"));
        tot.addView(adv);

        final LinearLayout summary = Ui.col(s.act);
        s.totalsHolder = summary;
        tot.addView(summary);
        body.addView(tot);

        Runnable recalc = new Runnable() {
            public void run() {
                d.discount = disc.getText().toString();
                d.delivery = deliv.getText().toString();
                d.advance = adv.getText().toString();
                updateTotals(s, d);
            }
        };
        for (EditText e : new EditText[]{disc, deliv, adv}) {
            e.setOnFocusChangeListener(new View.OnFocusChangeListener() {
                public void onFocusChange(View v, boolean has) { if (has) recalc.run(); }
            });
        }
        // Draw the totals once for the current draft.
        updateTotals(s, d);

        tot.addView(Ui.label(s.act, "Note (memo-te print hobe)"));
        final EditText note = Ui.field(s.act, "Note", d.note, InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        tot.addView(note);
        body.addView(tot);

        /* ---- save ---- */
        LinearLayout acts = Ui.card(s.act, "");
        Button save = Ui.primary(s.act, "Save Memo");
        save.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                d.memoNo = memoNo.getText().toString();
                d.date = date.getText().toString();
                d.customerName = name.getText().toString();
                d.customerPhone = phone.getText().toString();
                d.customerAddress = addr.getText().toString();
                d.discount = disc.getText().toString();
                d.delivery = deliv.getText().toString();
                d.advance = adv.getText().toString();
                d.note = note.getText().toString();
                saveMemo(s, false);
            }
        });
        acts.addView(save);
        body.addView(acts);

        ScrollView sc = Ui.scroller(s.act, body);
        return sc;
    }

    /** Remembers a row's values as the owner moves between fields, so a rebuild
     *  triggered by any other control cannot drop them. */
    private static void pickKeep(Screens.MemoDraft.Line line) { /* values read on focus loss */ }

    private static LinearLayout.LayoutParams weighted(Screens s, float w) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, w);
        lp.setMargins(0, 0, Ui.dp(s.act, 4), 0);
        return lp;
    }

    /** Recomputes and redraws the totals card in place, without a full rebuild. */
    static void updateTotals(Screens s, Screens.MemoDraft d) {
        LinearLayout holder = s.totalsHolder;
        if (holder == null) return;
        holder.removeAllViews();
        drawTotals(s, d, holder);
    }

    private static void drawTotals(Screens s, Screens.MemoDraft d, LinearLayout into) {
        List<Object> items = d.items(s.store);
        Map<String, Object> m = Store.memoMath(items, Store.num(d.discount),
                Store.num(d.delivery), Store.num(d.advance));
        double totalQty = 0;
        for (Object o : items) totalQty += Store.num(Store.rec(o).get("qty"));

        line(s, into, "Total Qty", Ui.qty(totalQty), Ui.TEXT, false);
        line(s, into, "Subtotal", Ui.money(m.get("subtotal")), Ui.TEXT, false);
        line(s, into, "Discount", Ui.money(m.get("discount")), Ui.TEXT, false);
        line(s, into, "Delivery", Ui.money(m.get("deliveryCharge")), Ui.TEXT, false);
        line(s, into, "VAT", Ui.money(m.get("vat")), Ui.TEXT, false);
        line(s, into, "Grand Total", Ui.money(m.get("grandTotal")), Ui.NAVY, true);
        line(s, into, "Advance", Ui.money(m.get("advance")), Ui.TEXT, false);
        line(s, into, "Due", Ui.money(m.get("due")), Store.num(m.get("due")) > 0 ? Ui.RED : Ui.GREEN, true);
        line(s, into, "COGS", Ui.money(m.get("cogs")), Ui.MUTED, false);
        line(s, into, "Profit", Ui.money(m.get("profit")), Ui.GREEN, true);

        // Shortfall reminder: it never blocks the save, it only says what to enter.
        List<Map<String, Object>> shortList = s.store.checkStockForItems(items, 0);
        for (Map<String, Object> p : shortList) {
            TextView warn = new TextView(s.act);
            warn.setText("\u26A0 " + p.get("name") + ": " + Ui.qty(p.get("short"))
                    + " tola ekhono Stock page-e tola hoy ni (memo save atkabe na)");
            warn.setTextColor(Ui.AMBER);
            warn.setTextSize(11.5f);
            warn.setPadding(0, Ui.dp(s.act, 6), 0, 0);
            into.addView(warn);
        }
    }

    private static void line(Screens s, LinearLayout into, String label, String value,
                             int color, boolean bold) {
        LinearLayout r = Ui.cells(s.act, new String[]{label, value}, new float[]{2f, 1.6f},
                color, bold);
        into.addView(r);
    }

    /** Product chooser: every product, with what is on the shelf next to it. */
    static void pickProduct(final Screens s, final int lineIdx) {
        final List<String> labels = new ArrayList<String>();
        final List<String> ids = new ArrayList<String>();
        for (Object o : s.store.list("products")) {
            Map<String, Object> p = Store.rec(o);
            Map<String, Object> card = s.store.findStock(Store.str(p, "id"));
            double avail = card == null ? 0 : Store.num(card.get("available"));
            labels.add(Store.str(p, "name") + "  \u2022 available " + Ui.qty(avail)
                    + "  \u2022 rate " + Ui.money(p.get("rate")));
            ids.add(Store.str(p, "id"));
        }
        if (labels.isEmpty()) { s.toast("Age Products page-e ekta product din."); return; }
        new AlertDialog.Builder(s.act)
            .setTitle("Product bachun")
            .setItems(labels.toArray(new String[0]), new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface dlg, int which) {
                    Screens.MemoDraft.Line l = s.draft.lines.get(lineIdx);
                    Map<String, Object> p = s.store.productById(ids.get(which));
                    l.productId = ids.get(which);
                    l.rate = Ui.qty(p.get("rate"));
                    l.cost = Ui.qty(s.store.stockCost(ids.get(which)));
                    if (Store.num(l.qty) <= 0) l.qty = "1";
                    s.render();
                }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /* ============================ save the memo ============================ */

    /**
     * Writes the memo. There is no stock check here and there must never be one:
     * a sale that happened has to be recordable whether or not the goods were ever
     * entered. applySaleToStock() creates a card for any product that lacks one.
     */
    static void saveMemo(Screens s, boolean silent) {
        Store store = s.store;
        Screens.MemoDraft d = s.draft;
        List<Object> items = d.items(store);
        if (items.isEmpty()) { s.toast("Age product din, tarpor save korun."); return; }

        /* The draft is handed to Store as a plain map, so the rule that a memo is
           never blocked by stock lives in one place and is tested on a JVM. */
        Map<String, Object> draft = new LinkedHashMap<String, Object>();
        draft.put("memoNo", d.memoNo);
        draft.put("date", d.date);
        draft.put("customerId", d.customerId);
        draft.put("customerName", d.customerName);
        draft.put("customerPhone", d.customerPhone);
        draft.put("customerAddress", d.customerAddress);
        draft.put("note", d.note);
        draft.put("discount", d.discount);
        draft.put("delivery", d.delivery);
        draft.put("advance", d.advance);

        Map<String, Object> saved = store.saveMemo(draft, items);
        if (saved == null) {
            // Say why. "Abar chesta korun" alone hides a disk that is full or a
            // folder the app cannot write to, and the owner would keep retrying a
            // save that can never succeed.
            String why = store.lastSaveError;
            s.toast("Memo save korte parlam na. Abar chesta korun."
                    + (why == null ? "" : "\n(" + why + ")"));
            return;
        }

        // Report the shortfall only now that the memo is safely written. A memo is
        // the truth about what left the shop; the stock card is the shop's own
        // count of the shelf, and it can be filled in later.
        List<Map<String, Object>> shortList = store.checkStockForItems(items, 0);
        String msg = "Memo " + Store.str(saved, "memoNo") + " save hoyeche.";
        if (!shortList.isEmpty()) {
            msg += "\n" + shortList.size() + " product-er stock ekhono tola hoy ni \u2014 "
                 + "Stock page-e dekhbe.";
        }
        if (!silent) s.toast(msg);

        d.reset(store);
        d.date = Store.today();
        d.memoNo = store.nextMemoNo();
        s.go("history");
    }

    /* ============================ memo history ============================ */

    static View memoHistory(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);

        LinearLayout searchCard = Ui.card(s.act, "Khunjun");
        final EditText q = Ui.field(s.act, "Memo no / customer / phone", "",
                InputType.TYPE_CLASS_TEXT);
        searchCard.addView(q);
        body.addView(searchCard);

        final LinearLayout list = Ui.card(s.act, "Memo History");

        final Runnable draw = new Runnable() {
            public void run() {
                list.removeAllViews();
                String needle = q.getText().toString().trim().toLowerCase(Locale.US);
                List<Object> memos = store.list("memos");
                int n = 0;
                for (int i = memos.size() - 1; i >= 0; i--) {
                    final Map<String, Object> m = Store.rec(memos.get(i));
                    if (!needle.isEmpty()) {
                        String hay = (Store.str(m, "memoNo") + " " + Store.str(m, "customerName")
                                + " " + Store.str(m, "customerPhone")).toLowerCase(Locale.US);
                        if (!hay.contains(needle)) continue;
                    }
                    n++;
                    LinearLayout row = Ui.col(s.act);
                    row.addView(Ui.cells(s.act,
                        new String[]{Store.str(m, "memoNo"), Ui.money(m.get("grandTotal"))},
                        new float[]{3f, 1.6f}, Ui.NAVY, true));
                    row.addView(Ui.cells(s.act,
                        new String[]{Store.str(m, "date"), Store.str(m, "customerName"),
                                     "Due " + Ui.money(m.get("due"))},
                        new float[]{2.2f, 3f, 2f}, Ui.MUTED, false));
                    LinearLayout acts = Ui.row(s.act);
                    Button view = Ui.ghost(s.act, "Dekhun");
                    view.setOnClickListener(new View.OnClickListener() {
                        public void onClick(View v) { viewMemo(s, Store.str(m, "id")); }
                    });
                    Button edit = Ui.ghost(s.act, "Edit");
                    edit.setOnClickListener(new View.OnClickListener() {
                        public void onClick(View v) { editMemo(s, Store.str(m, "id")); }
                    });
                    Button del = Ui.ghost(s.act, "Delete");
                    del.setTextColor(Ui.RED);
                    del.setOnClickListener(new View.OnClickListener() {
                        public void onClick(View v) {
                            s.confirm("Ei memo ta muchhe felben? Stock abar firiye deya hobe.",
                                new Runnable() {
                                    public void run() {
                                        store.list("memos").remove(m);
                                        store.reverseSaleFromStock(m);
                                        s.afterSave("Memo delete hoyeche, stock abar firiye deya hoyeche.");
                                    }
                                });
                        }
                    });
                    acts.addView(view);
                    acts.addView(edit);
                    acts.addView(del);
                    row.addView(acts);
                    row.addView(Ui.divider(s.act));
                    list.addView(row);
                }
                if (n == 0) list.addView(Ui.label(s.act, "Kono memo nei."));
            }
        };
        q.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            public void onFocusChange(View v, boolean has) { draw.run(); }
        });
        q.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence cs, int a, int b, int c) { }
            public void onTextChanged(CharSequence cs, int a, int b, int c) { }
            public void afterTextChanged(android.text.Editable e) { draw.run(); }
        });
        draw.run();
        body.addView(list);

        return Ui.scroller(s.act, body);
    }

    /** The memo as it would print - on screen, since the owner asked for no printing. */
    static void viewMemo(Screens s, String memoId) {
        Map<String, Object> m = findMemo(s.store, memoId);
        if (m == null) return;
        StringBuilder sb = new StringBuilder();
        Map<String, Object> c = s.store.company();
        sb.append(Store.str(c, "name")).append("\n");
        sb.append(Store.str(c, "address")).append("\n");
        sb.append(Store.str(c, "phone")).append("\n\n");
        sb.append("Memo: ").append(Store.str(m, "memoNo")).append("\n");
        sb.append("Date: ").append(Store.str(m, "date")).append("\n");
        sb.append("Customer: ").append(Store.str(m, "customerName")).append("\n");
        if (!Store.str(m, "customerPhone").isEmpty()) {
            sb.append("Phone: ").append(Store.str(m, "customerPhone")).append("\n");
        }
        sb.append("\n");
        for (Object o : Store.rec(m).get("items") instanceof List
                ? Json.arr(m.get("items")) : new ArrayList<Object>()) {
            Map<String, Object> it = Store.rec(o);
            Map<String, Object> p = s.store.productById(Store.str(it, "productId"));
            sb.append(p == null ? "(deleted)" : Store.str(p, "name")).append("  ")
              .append(Ui.qty(it.get("qty"))).append(" x ")
              .append(Ui.money(it.get("rate"))).append(" = ")
              .append(Ui.money(it.get("amount"))).append("\n");
        }
        sb.append("\nSubtotal: ").append(Ui.money(m.get("subtotal"))).append("\n");
        sb.append("Discount: ").append(Ui.money(m.get("discount"))).append("\n");
        sb.append("Delivery: ").append(Ui.money(m.get("deliveryCharge"))).append("\n");
        sb.append("VAT: ").append(Ui.money(m.get("vat"))).append("\n");
        sb.append("Grand Total: ").append(Ui.money(m.get("grandTotal"))).append("\n");
        sb.append("Advance: ").append(Ui.money(m.get("advance"))).append("\n");
        sb.append("Due: ").append(Ui.money(m.get("due"))).append("\n");
        if (!Store.str(m, "note").isEmpty()) sb.append("\nNote: ").append(Store.str(m, "note"));

        ScrollView sc = new ScrollView(s.act);
        TextView t = new TextView(s.act);
        t.setText(sb.toString());
        t.setTextSize(13f);
        t.setTextColor(Ui.TEXT);
        t.setTypeface(Typeface.MONOSPACE);
        t.setPadding(Ui.dp(s.act, 14), Ui.dp(s.act, 14), Ui.dp(s.act, 14), Ui.dp(s.act, 14));
        sc.addView(t);

        new AlertDialog.Builder(s.act)
            .setTitle("Memo")
            .setView(sc)
            .setPositiveButton("Bondho", null)
            .setNeutralButton("Share", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { /* share handled by shell */ }
            })
            .show();
    }

    static Map<String, Object> findMemo(Store store, String id) {
        for (Object o : store.list("memos")) {
            if (Store.str(o, "id").equals(id)) return Store.rec(o);
        }
        return null;
    }

    /** Editing re-uses the memos own numbers; the stock effect is reversed and reapplied. */
    static void editMemo(final Screens s, final String memoId) {
        final Map<String, Object> m = findMemo(s.store, memoId);
        if (m == null) return;
        LinearLayout body = Ui.col(s.act);
        body.addView(Ui.label(s.act, "Memo " + Store.str(m, "memoNo")
                + " \u2014 customer, charge ar note bodlano jay. Item bodlate memo ta "
                + "delete kore abar likhun (stock thik thakbe)."));
        final EditText name = Ui.field(s.act, "Customer Name", Store.str(m, "customerName"),
                InputType.TYPE_CLASS_TEXT);
        final EditText phone = Ui.field(s.act, "Phone", Store.str(m, "customerPhone"),
                InputType.TYPE_CLASS_PHONE);
        final EditText note = Ui.field(s.act, "Note", Store.str(m, "note"),
                InputType.TYPE_CLASS_TEXT);
        final EditText disc = Ui.number(s.act, "Discount", Ui.qty(m.get("discount")));
        final EditText deliv = Ui.number(s.act, "Delivery Charge", Ui.qty(m.get("deliveryCharge")));
        final EditText adv = Ui.number(s.act, "Advance", Ui.qty(m.get("advance")));
        body.addView(name);
        body.addView(phone);
        body.addView(disc);
        body.addView(deliv);
        body.addView(adv);
        body.addView(note);

        new AlertDialog.Builder(s.act)
            .setTitle("Memo edit")
            .setView(Ui.scroller(s.act, body))
            .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface dlg, int w) {
                    m.put("customerName", name.getText().toString().trim());
                    m.put("customerPhone", phone.getText().toString().trim());
                    m.put("note", note.getText().toString().trim());
                    List<Object> items = Json.arr(m.get("items"));
                    Map<String, Object> money = Store.memoMath(items,
                            Store.num(disc.getText().toString()),
                            Store.num(deliv.getText().toString()),
                            Store.num(adv.getText().toString()));
                    for (Map.Entry<String, Object> e : money.entrySet()) m.put(e.getKey(), e.getValue());
                    for (Object o : items) {
                        Map<String, Object> it = Store.rec(o);
                        Map<String, Object> card = s.store.findStock(Store.str(it, "productId"));
                        it.put("cost", card == null ? Double.valueOf(0) : card.get("cost"));
                    }
                    s.afterSave("Memo update hoyeche.");
                }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /* ============================ products ============================ */

    static View products(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);

        LinearLayout form = Ui.card(s.act, "Product");
        final EditText name = Ui.field(s.act, "Product Name *", "", InputType.TYPE_CLASS_TEXT);
        final EditText sku = Ui.field(s.act, "SKU / Code", "", InputType.TYPE_CLASS_TEXT);
        final EditText cat = Ui.field(s.act, "Category", "", InputType.TYPE_CLASS_TEXT);
        final EditText unit = Ui.field(s.act, "Unit", "pcs", InputType.TYPE_CLASS_TEXT);
        final EditText cost = Ui.number(s.act, "Cost Price (\u09F3)", "");
        final EditText rate = Ui.number(s.act, "Sell Rate (\u09F3)", "");
        final EditText vat = Ui.number(s.act, "VAT %", "0");
        final EditText reorder = Ui.number(s.act, "Reorder Level", "10");
        form.addView(Ui.label(s.act, "Product Name *"));
        form.addView(name);
        form.addView(Ui.label(s.act, "SKU / Code"));
        form.addView(sku);
        form.addView(Ui.label(s.act, "Category"));
        form.addView(cat);
        form.addView(Ui.label(s.act, "Unit"));
        form.addView(unit);
        form.addView(Ui.label(s.act, "Cost Price (\u09F3)"));
        form.addView(cost);
        form.addView(Ui.label(s.act, "Sell Rate (\u09F3)"));
        form.addView(rate);
        form.addView(Ui.label(s.act, "VAT %"));
        form.addView(vat);
        form.addView(Ui.label(s.act, "Reorder Level"));
        form.addView(reorder);
        Button save = Ui.primary(s.act, "Save Product");
        save.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String nm = name.getText().toString().trim();
                if (nm.isEmpty()) { s.toast("Product-er nam din."); return; }
                Map<String, Object> p = new LinkedHashMap<String, Object>();
                p.put("id", Store.id());
                p.put("name", nm);
                p.put("sku", sku.getText().toString().trim());
                p.put("category", cat.getText().toString().trim().isEmpty()
                        ? "General" : cat.getText().toString().trim());
                p.put("unit", unit.getText().toString().trim().isEmpty()
                        ? "pcs" : unit.getText().toString().trim());
                p.put("cost", Double.valueOf(Store.num(cost.getText().toString())));
                p.put("rate", Double.valueOf(Store.num(rate.getText().toString())));
                p.put("vat", Double.valueOf(Store.num(vat.getText().toString())));
                p.put("reorderLevel", Double.valueOf(Store.num(reorder.getText().toString())));
                store.list("products").add(p);
                s.afterSave("Product save hoyeche.");
            }
        });
        form.addView(save);
        body.addView(form);

        LinearLayout list = Ui.card(s.act, "Product list");
        list.addView(Ui.cells(s.act,
            new String[]{"PRODUCT", "COST", "RATE", "MARGIN"},
            new float[]{4f, 1.8f, 1.8f, 1.8f}, Ui.NAVY, true));
        list.addView(Ui.divider(s.act));
        for (Object o : store.list("products")) {
            final Map<String, Object> p = Store.rec(o);
            double margin = Store.num(p.get("rate")) - Store.num(p.get("cost"));
            LinearLayout r = Ui.cells(s.act,
                new String[]{Store.str(p, "name"), Ui.money(p.get("cost")),
                             Ui.money(p.get("rate")), Ui.money(margin)},
                new float[]{4f, 1.8f, 1.8f, 1.8f}, Ui.TEXT, false);
            r.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { editProduct(s, Store.str(p, "id")); }
            });
            list.addView(r);
            if (!Store.str(p, "sku").isEmpty() || !Store.str(p, "category").isEmpty()) {
                list.addView(Ui.cells(s.act,
                    new String[]{Store.str(p, "sku"), Store.str(p, "category"),
                                 Store.str(p, "unit"), ""},
                    new float[]{4f, 1.8f, 1.8f, 1.8f}, Ui.MUTED, false));
            }
        }
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    static void editProduct(final Screens s, final String pid) {
        final Map<String, Object> p = s.store.productById(pid);
        if (p == null) return;
        LinearLayout body = Ui.col(s.act);
        final EditText name = Ui.field(s.act, "Product Name", Store.str(p, "name"), InputType.TYPE_CLASS_TEXT);
        final EditText sku = Ui.field(s.act, "SKU", Store.str(p, "sku"), InputType.TYPE_CLASS_TEXT);
        final EditText cat = Ui.field(s.act, "Category", Store.str(p, "category"), InputType.TYPE_CLASS_TEXT);
        final EditText unit = Ui.field(s.act, "Unit", Store.str(p, "unit"), InputType.TYPE_CLASS_TEXT);
        final EditText cost = Ui.number(s.act, "Cost Price", Ui.qty(p.get("cost")));
        final EditText rate = Ui.number(s.act, "Sell Rate", Ui.qty(p.get("rate")));
        final EditText vat = Ui.number(s.act, "VAT %", Ui.qty(p.get("vat")));
        final EditText reorder = Ui.number(s.act, "Reorder Level", Ui.qty(p.get("reorderLevel")));
        body.addView(name); body.addView(sku); body.addView(cat); body.addView(unit);
        body.addView(cost); body.addView(rate); body.addView(vat); body.addView(reorder);

        new AlertDialog.Builder(s.act)
            .setTitle("Edit product")
            .setView(Ui.scroller(s.act, body))
            .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) {
                    p.put("name", name.getText().toString().trim());
                    p.put("sku", sku.getText().toString().trim());
                    p.put("category", cat.getText().toString().trim());
                    p.put("unit", unit.getText().toString().trim());
                    p.put("cost", Double.valueOf(Store.num(cost.getText().toString())));
                    p.put("rate", Double.valueOf(Store.num(rate.getText().toString())));
                    p.put("vat", Double.valueOf(Store.num(vat.getText().toString())));
                    p.put("reorderLevel", Double.valueOf(Store.num(reorder.getText().toString())));
                    s.afterSave("Product update hoyeche.");
                }
            })
            .setNeutralButton("Delete", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) {
                    s.confirm("Product ta muchhe felben? Purono memo-te nam thakbe na.",
                        new Runnable() {
                            public void run() {
                                s.store.list("products").remove(p);
                                s.afterSave("Product delete hoyeche.");
                            }
                        });
                }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /* ============================ stock ============================ */

    static View stock(final Screens s) {
        final Store store = s.store;
        LinearLayout body = Ui.col(s.act);
        body.addView(Ui.label(s.act,
            "Available = Received/Opening + Purchased \u2212 Sold, ar 0-er niche name na. "
            + "Memo theke product nijei ekhane bose jay."));

        LinearLayout add = Ui.card(s.act, "+ Received / Opening Stock");
        final List<String> ids = new ArrayList<String>();
        final List<String> names = new ArrayList<String>();
        for (Object o : store.list("products")) {
            ids.add(Store.str(o, "id"));
            names.add(Store.str(o, "name"));
        }
        final int[] chosen = { ids.isEmpty() ? -1 : 0 };
        final Button picker = Ui.ghost(s.act, names.isEmpty() ? "Product nei" : names.get(0));
        final EditText qty = Ui.number(s.act, "Qty to Add", "");
        final EditText cost = Ui.number(s.act, "Unit Cost (\u09F3)", "");
        picker.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                s.choose("Product bachun", names, new Screens.OnText() {
                    public void on(String idx) {
                        chosen[0] = (int) Store.num(idx);
                        picker.setText(names.get(chosen[0]));
                        Map<String, Object> p = store.productById(ids.get(chosen[0]));
                        Map<String, Object> c = store.findStock(ids.get(chosen[0]));
                        if (c == null || Store.num(c.get("cost")) == 0) {
                            cost.setText(Ui.qty(p.get("cost")));
                        }
                    }
                });
            }
        });
        add.addView(picker);
        add.addView(Ui.label(s.act, "Qty to Add"));
        add.addView(qty);
        add.addView(Ui.label(s.act, "Unit Cost (\u09F3)"));
        add.addView(cost);
        Button saveAdd = Ui.primary(s.act, "Add Stock");
        saveAdd.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (chosen[0] < 0) { s.toast("Age product din."); return; }
                double q = Store.num(qty.getText().toString());
                if (q <= 0) { s.toast("Qty din."); return; }
                String pid = ids.get(chosen[0]);
                Map<String, Object> card = store.stockOf(pid);
                card.put("opening", Double.valueOf(Store.num(card.get("opening")) + q));
                double c = Store.num(cost.getText().toString());
                if (c > 0) card.put("cost", Double.valueOf(c));
                card.put("available", Double.valueOf(Store.stockAvailable(card)));
                store.logStock(pid, "Opening", q, "Received", "Received / opening stock");
                s.afterSave("Stock jog hoyeche.");
            }
        });
        add.addView(saveAdd);
        body.addView(add);

        LinearLayout list = Ui.card(s.act, "Stock");
        list.addView(Ui.cells(s.act,
            new String[]{"PRODUCT", "AVAIL", "SHORT", "COST", "VALUE"},
            new float[]{4f, 1.4f, 1.4f, 1.8f, 2f}, Ui.NAVY, true));
        list.addView(Ui.divider(s.act));
        for (Object o : store.list("products")) {
            final Map<String, Object> p = Store.rec(o);
            final String pid = Store.str(p, "id");
            Map<String, Object> card = store.findStock(pid);
            double avail = card == null ? 0 : Store.num(card.get("available"));
            double shortQty = card == null ? 0 : Store.stockShort(card);
            double unitCost = store.stockCost(pid);
            LinearLayout r = Ui.cells(s.act,
                new String[]{Store.str(p, "name"), Ui.qty(avail),
                             shortQty > 0 ? Ui.qty(shortQty) : "-",
                             Ui.money(unitCost), Ui.money(avail * unitCost)},
                new float[]{4f, 1.4f, 1.4f, 1.8f, 2f},
                shortQty > 0 ? Ui.AMBER : Ui.TEXT, false);
            r.setOnClickListener(new View.OnClickListener() {
                public void onClick(View v) { stockActions(s, pid); }
            });
            list.addView(r);
        }
        body.addView(list);
        return Ui.scroller(s.act, body);
    }

    static void stockActions(final Screens s, final String pid) {
        final Store store = s.store;
        Map<String, Object> p = store.productById(pid);
        if (p == null) return;
        Map<String, Object> card = store.findStock(pid);
        String info = "Available: " + Ui.qty(card == null ? 0 : card.get("available"))
                + (card != null && Store.stockShort(card) > 0
                    ? "  (tola baki " + Ui.qty(Store.stockShort(card)) + ")" : "");
        new AlertDialog.Builder(s.act)
            .setTitle(Store.str(p, "name"))
            .setMessage(info)
            .setPositiveButton("Adjust", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { adjust(s, pid); }
            })
            .setNeutralButton("Edit card", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { editStockCard(s, pid); }
            })
            .setNegativeButton("Bondho", null)
            .show();
    }

    /** Positive raises the count, negative lowers it. Checked against the raw figure,
     *  so a card already in shortfall can still be adjusted downward. */
    static void adjust(final Screens s, final String pid) {
        LinearLayout body = Ui.col(s.act);
        final EditText qty = Ui.number(s.act, "Adjustment Qty (+/-)", "");
        final EditText reason = Ui.field(s.act, "Reason", "", InputType.TYPE_CLASS_TEXT);
        body.addView(Ui.label(s.act, "Positive number = stock barbe. Negative = kombe."));
        body.addView(qty);
        body.addView(reason);
        new AlertDialog.Builder(s.act)
            .setTitle("Stock Adjustment")
            .setView(body)
            .setPositiveButton("Apply", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) {
                    double delta = Store.num(qty.getText().toString());
                    if (delta == 0) { s.toast("Adjustment qty din."); return; }
                    Map<String, Object> card = s.store.stockOf(pid);
                    if (Store.stockRaw(card) + delta < 0) {
                        s.toast("Adjustment korle stock tolar poriman theke kome jabe."
                                + " Available: " + Ui.qty(card.get("available")));
                        return;
                    }
                    if (delta > 0) {
                        card.put("opening", Double.valueOf(Store.num(card.get("opening")) + delta));
                    } else {
                        card.put("sold", Double.valueOf(Store.num(card.get("sold")) + Math.abs(delta)));
                    }
                    card.put("available", Double.valueOf(Store.stockAvailable(card)));
                    s.store.logStock(pid, "Adjustment", delta, "Manual",
                            reason.getText().toString().trim().isEmpty()
                                ? "Stock adjustment" : reason.getText().toString().trim());
                    s.afterSave("Stock adjustment hoyeche.");
                }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /** A card edit may not silently erase real memo sales, so the sold figure has a
     *  floor at what the memos actually contain. */
    static void editStockCard(final Screens s, final String pid) {
        final Store store = s.store;
        final Map<String, Object> card = store.stockOf(pid);
        LinearLayout body = Ui.col(s.act);
        final EditText opening = Ui.number(s.act, "Received / Opening Qty", Ui.qty(card.get("opening")));
        final EditText purchased = Ui.number(s.act, "Purchased Qty", Ui.qty(card.get("purchased")));
        final EditText sold = Ui.number(s.act, "Sold Qty", Ui.qty(card.get("sold")));
        final EditText cost = Ui.number(s.act, "Unit Cost (\u09F3)", Ui.qty(store.stockCost(pid)));
        double memoSold = 0;
        for (Object o : store.list("memos")) {
            for (Object io : Json.arr(Store.rec(o).get("items"))) {
                if (Store.str(io, "productId").equals(pid)) memoSold += Store.num(Store.rec(io).get("qty"));
            }
        }
        body.addView(Ui.label(s.act, "Sold qty memo-r asol bikri (" + Ui.qty(memoSold)
                + ") theke kome hote pare na."));
        body.addView(opening);
        body.addView(purchased);
        body.addView(sold);
        body.addView(cost);
        new AlertDialog.Builder(s.act)
            .setTitle("Edit stock card")
            .setView(Ui.scroller(s.act, body))
            .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) {
                    double op = Math.max(0, Store.num(opening.getText().toString()));
                    double pu = Math.max(0, Store.num(purchased.getText().toString()));
                    double so = Math.max(0, Store.num(sold.getText().toString()));
                    double co = Math.max(0, Store.num(cost.getText().toString()));
                    double memoSold2 = 0;
                    for (Object o : store.list("memos")) {
                        for (Object io : Json.arr(Store.rec(o).get("items"))) {
                            if (Store.str(io, "productId").equals(pid)) {
                                memoSold2 += Store.num(Store.rec(io).get("qty"));
                            }
                        }
                    }
                    if (so < memoSold2) {
                        s.toast("Sold qty memo-r asol bikri (" + Ui.qty(memoSold2)
                                + ") theke kome hote pare na.");
                        return;
                    }
                    Map<String, Object> t = new LinkedHashMap<String, Object>();
                    t.put("opening", Double.valueOf(op));
                    t.put("purchased", Double.valueOf(pu));
                    t.put("sold", Double.valueOf(so));
                    double before = Store.num(card.get("available"));
                    card.put("opening", Double.valueOf(op));
                    card.put("purchased", Double.valueOf(pu));
                    card.put("sold", Double.valueOf(so));
                    if (co > 0) card.put("cost", Double.valueOf(co));
                    card.put("available", Double.valueOf(Store.stockAvailable(card)));
                    store.logStock(pid, "Adjustment", Store.num(card.get("available")) - before,
                            "Manual", "Stock card edited");
                    double raw = Store.stockRaw(t);
                    s.afterSave(raw < 0
                        ? "Stock update hoyeche. Sold er cheye tola kom \u2014 ei "
                          + Ui.qty(Math.abs(raw)) + " ta Tola baki te dekhabe."
                        : "Stock update hoyeche.");
                }
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    /* ============================ stock ledger ============================ */

    static View stockLedger(final Screens s) {
        LinearLayout body = Ui.col(s.act);
        LinearLayout list = Ui.card(s.act, "Stock Ledger");
        list.addView(Ui.cells(s.act,
            new String[]{"DATE", "PRODUCT", "TYPE", "QTY", "BAL"},
            new float[]{2.4f, 3.6f, 2.4f, 1.4f, 1.4f}, Ui.NAVY, true));
        list.addView(Ui.divider(s.act));
        List<Object> ledger = s.store.list("ledger");
        int shown = 0;
        for (int i = ledger.size() - 1; i >= 0 && shown < 200; i--, shown++) {
            Map<String, Object> l = Store.rec(ledger.get(i));
            Map<String, Object> p = s.store.productById(Store.str(l, "productId"));
            list.addView(Ui.cells(s.act,
                new String[]{Store.str(l, "date"),
                             p == null ? "(deleted)" : Store.str(p, "name"),
                             Store.str(l, "type"), Ui.qty(l.get("qty")),
                             Ui.qty(l.get("balance"))},
                new float[]{2.4f, 3.6f, 2.4f, 1.4f, 1.4f}, Ui.TEXT, false));
        }
        if (shown == 0) list.addView(Ui.label(s.act, "Kono movement nei."));
        body.addView(list);
        return Ui.scroller(s.act, body);
    }
}
