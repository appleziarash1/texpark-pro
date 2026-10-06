package com.texpark.pro;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The sales memo as a sheet, drawn with real views.
 *
 * This is the phone's half of one design. The web app builds the same sheet in
 * HTML (js/app.js, memoSheet + MEMO_CSS); this builds it out of Android views, and
 * both are meant to look like the same document - navy header band, Bill To and
 * From boxes, a striped item table, the totals card with the grand total and the
 * due highlighted, and two signature lines. The words and the terms come from
 * {@link Store} constants, so the two renderers cannot disagree about what the
 * memo says even though they cannot share a stylesheet.
 *
 * The view is also what gets shared: {@link #toBitmap} draws it onto a canvas for
 * the PNG, and {@link #toPdf} draws it onto a PdfDocument page. The owner asked for
 * a memo he can send on WhatsApp, and a bitmap of the sheet he is looking at is
 * exactly that - a second, hand-written export layout would be a second thing to
 * keep in step.
 */
final class MemoSheet {

    private static final int NAVY = Ui.NAVY;
    /* The red accent line under the header and the card headings. Picked to match
       the web sheet's #d92d4b so a memo looks the same printed from the phone and
       from the PC. */
    private static final int RED = 0xFFD92D4B;
    private static final int LINE = 0xFFDBE3EC;
    private static final int MUTED = 0xFF64748B;
    private static final int HEAD_BG = 0xFF0F2B52;
    private static final int ROW_ALT = 0xFFF8FAFC;
    private static final int ON_NAVY = 0xFFCFDCEE;
    private static final int STRIP_BG = 0xFFF1F5F9;
    private static final int DUE = 0xFFB3183A;
    private static final int DUE_BG = 0xFFFEF2F4;

    private MemoSheet() {}

    /** The sheet for one memo, ready to show, measure or draw. */
    static LinearLayout build(Context c, Map<String, Object> m, Map<String, Object> company) {
        LinearLayout sheet = Ui.col(c);
        sheet.setBackgroundColor(Color.WHITE);
        int p = Ui.dp(c, 12);
        sheet.setPadding(p, p, p, p);

        sheet.addView(header(c, m, company));
        sheet.addView(rule(c, RED, 3));
        sheet.addView(strip(c, m));
        sheet.addView(cards(c, m, company));
        sheet.addView(items(c, m));
        sheet.addView(footer(c, m));
        sheet.addView(signatures(c));
        sheet.addView(thanks(c));
        return sheet;
    }

    /* ------------------------------------------------------------ header */

    private static View header(Context c, Map<String, Object> m, Map<String, Object> company) {
        LinearLayout bar = Ui.row(c);
        bar.setBackground(rounded(c, NAVY, new float[]{10, 10, 10, 10, 0, 0, 0, 0}));
        int p = Ui.dp(c, 12);
        bar.setPadding(p, p, p, p);

        TextView logo = new TextView(c);
        logo.setText(Store.initials(Store.str(company, "name")));
        logo.setTextColor(NAVY);
        logo.setTextSize(16f);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setGravity(Gravity.CENTER);
        logo.setBackground(rounded(c, Color.WHITE, new float[]{9, 9, 9, 9, 9, 9, 9, 9}));
        int s = Ui.dp(c, 44);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(s, s);
        lp.setMargins(0, 0, Ui.dp(c, 10), 0);
        logo.setLayoutParams(lp);
        bar.addView(logo);

        LinearLayout who = Ui.col(c);
        TextView name = new TextView(c);
        name.setText(Store.str(company, "name"));
        name.setTextColor(Color.WHITE);
        name.setTextSize(16.5f);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        who.addView(name);
        who.addView(caps(c, Store.str(company, "tagline"), 9.5f, ON_NAVY));
        if (!Store.str(company, "md").isEmpty()) {
            TextView md = new TextView(c);
            md.setText("MD: " + Store.str(company, "md"));
            md.setTextColor(ON_NAVY);
            md.setTextSize(9.5f);
            who.addView(md);
        }
        bar.addView(who, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        LinearLayout doc = Ui.col(c);
        doc.setGravity(Gravity.END);
        doc.addView(caps(c, "Sales Memo", 13f, Color.WHITE));
        doc.addView(headLine(c, "Memo No:", Store.str(m, "memoNo")));
        doc.addView(headLine(c, "Date:", Store.str(m, "date")));
        doc.addView(headLine(c, "Total Qty:", Store.qty(m.get("totalQty"))));
        bar.addView(doc);
        return bar;
    }

    private static TextView headLine(Context c, String label, String value) {
        TextView t = new TextView(c);
        t.setText(label + " " + value);
        t.setTextColor(ON_NAVY);
        t.setTextSize(10f);
        t.setGravity(Gravity.END);
        return t;
    }

    private static TextView caps(Context c, String text, float size, int color) {
        TextView t = new TextView(c);
        t.setText(text == null ? "" : text.toUpperCase(java.util.Locale.US));
        t.setTextColor(color);
        t.setTextSize(size);
        if (android.os.Build.VERSION.SDK_INT >= 21) t.setLetterSpacing(0.14f);
        return t;
    }

    /* A coloured rule across the sheet. Used for the red accent under the header
       band; a plain View is cheaper than a border on the neighbouring layout and
       keeps the header's rounded corners intact. */
    private static View rule(Context c, int color, int dpHeight) {
        View v = new View(c);
        v.setBackgroundColor(color);
        v.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(c, dpHeight)));
        return v;
    }

    /* The three meta fields that sit between the header and the party boxes, the
       same strip the web sheet prints. */
    private static View strip(Context c, Map<String, Object> m) {
        LinearLayout row = Ui.row(c);
        row.setBackgroundColor(STRIP_BG);
        int p = Ui.dp(c, 8);
        row.setPadding(p, p, p, p);
        row.addView(stripCell(c, "Due Date", dueDate(Store.str(m, "date"))));
        row.addView(stripCell(c, "Payment", "Cash / bKash"));
        row.addView(stripCell(c, "Delivery", "Shop pick-up"));
        return row;
    }

    private static View stripCell(Context c, String label, String value) {
        TextView t = new TextView(c);
        t.setText(label + ": " + value);
        t.setTextColor(Ui.TEXT);
        t.setTextSize(10f);
        t.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return t;
    }

    /** The payment-due date the web sheet prints: 15 days after the sale. */
    private static String dueDate(String date) {
        try {
            SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            Date d = in.parse(date);
            if (d == null) return date == null || date.isEmpty() ? "-" : date;
            Calendar cal = Calendar.getInstance();
            cal.setTime(d);
            cal.add(Calendar.DAY_OF_MONTH, 15);
            return in.format(cal.getTime());
        } catch (Exception e) {
            return date == null || date.isEmpty() ? "-" : date;
        }
    }

    /* ------------------------------------------------------ party boxes */

    private static View cards(Context c, Map<String, Object> m, Map<String, Object> company) {
        LinearLayout row = Ui.row(c);
        row.setBackground(bordered(c, Color.WHITE));
        row.addView(party(c, "Bill To", Store.str(m, "customerName"),
                lines("Phone: " + Store.str(m, "customerPhone"),
                      Store.str(m, "customerAddress")), true));
        row.addView(party(c, "From", Store.str(company, "name"),
                Store.contactLines(company), false));
        return row;
    }

    private static View party(Context c, String title, String who, List<String> lines,
                              boolean dividerRight) {
        LinearLayout box = Ui.col(c);
        int p = Ui.dp(c, 10);
        box.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        box.setLayoutParams(lp);
        box.addView(caps(c, title, 9f, RED));
        TextView name = new TextView(c);
        name.setText(who == null ? "" : who);
        name.setTextColor(NAVY);
        name.setTextSize(12.5f);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(name);
        for (String l : lines) {
            TextView t = new TextView(c);
            t.setText(l);
            t.setTextColor(Ui.TEXT);
            t.setTextSize(10.5f);
            box.addView(t);
        }
        return box;
    }

    private static List<String> lines(String... v) {
        List<String> out = new ArrayList<String>();
        for (String s : v) if (s != null && !s.trim().isEmpty()) out.add(s);
        return out;
    }

    /* ------------------------------------------------------- item table */

    private static View items(Context c, Map<String, Object> m) {
        LinearLayout table = Ui.col(c);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, Ui.dp(c, 12), 0, 0);
        table.setLayoutParams(lp);

        table.addView(itemRow(c, new String[]{"SL", "Product Description", "Rate", "Qty", "Amount"},
                HEAD_BG, NAVY, true));
        List<Object> items = Json.arr(m.get("items"));
        if (items.isEmpty()) {
            TextView empty = new TextView(c);
            empty.setText("No products");
            empty.setTextColor(MUTED);
            empty.setTextSize(11f);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, Ui.dp(c, 10), 0, Ui.dp(c, 10));
            table.addView(empty);
            return table;
        }
        for (int i = 0; i < items.size(); i++) {
            Map<String, Object> it = Store.rec(items.get(i));
            table.addView(itemRow(c, new String[]{
                String.format(java.util.Locale.US, "%02d", i + 1),
                Store.str(it, "productName"),
                Store.money(it.get("rate")),
                Store.qty(it.get("qty")),
                Store.money(it.get("amount"))
            }, i % 2 == 1 ? ROW_ALT : Color.WHITE, Ui.TEXT, false));
        }
        return table;
    }

    private static View itemRow(Context c, String[] cells, int bg, int color, boolean head) {
        LinearLayout row = Ui.row(c);
        row.setBackgroundColor(bg);
        int p = Ui.dp(c, 7);
        row.setPadding(p, p, p, p);
        // Product name takes the leftover width; the four numbers stay narrow so the
        // columns line up down the sheet however long a product name is.
        float[] w = {0.5f, 3f, 1.1f, 0.8f, 1.4f};
        for (int i = 0; i < cells.length; i++) {
            TextView t = new TextView(c);
            t.setText(cells[i] == null ? "" : cells[i]);
            t.setTextColor(color);
            t.setTextSize(head ? 9.5f : 11f);
            if (head) {
                t.setTypeface(Typeface.DEFAULT_BOLD);
                if (android.os.Build.VERSION.SDK_INT >= 21) t.setLetterSpacing(0.08f);
            }
            t.setGravity(i >= 2 ? Gravity.END : Gravity.START);
            t.setLayoutParams(new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, w[i]));
            row.addView(t);
        }
        if (head) {
            View rule = new View(c);
            rule.setBackgroundColor(NAVY);
            row.setBackgroundColor(HEAD_BG);
            rule.setLayoutParams(new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(c, 2))));
            LinearLayout wrap = Ui.col(c);
            wrap.addView(row);
            wrap.addView(rule);
            return wrap;
        }
        return row;
    }

    /* --------------------------------------------------- words + totals */

    private static View footer(Context c, Map<String, Object> m) {
        LinearLayout row = Ui.row(c);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, Ui.dp(c, 12), 0, 0);
        row.setLayoutParams(lp);
        row.setGravity(Gravity.TOP);

        LinearLayout left = Ui.col(c);
        left.addView(words(c, m));
        if (!Store.str(m, "note").isEmpty()) {
            TextView note = new TextView(c);
            note.setText(Store.str(m, "note"));
            note.setTextColor(Ui.TEXT);
            note.setTextSize(10.5f);
            note.setPadding(0, Ui.dp(c, 7), 0, 0);
            left.addView(note);
        }
        TextView terms = new TextView(c);
        terms.setText(Store.MEMO_TERMS);
        terms.setTextColor(MUTED);
        terms.setTextSize(9.5f);
        terms.setPadding(0, Ui.dp(c, 8), 0, 0);
        left.addView(terms);
        row.addView(left, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        row.addView(totals(c, m));
        return row;
    }

    private static View words(Context c, Map<String, Object> m) {
        LinearLayout box = Ui.col(c);
        box.setBackground(rounded(c, 0xFFF8FAFD, new float[]{5, 5, 5, 5, 5, 5, 5, 5}));
        int p = Ui.dp(c, 8);
        box.setPadding(p, p, p, p);
        box.addView(caps(c, "Amount in Words", 9f, MUTED));
        TextView t = new TextView(c);
        t.setText(Store.numberWords(m.get("grandTotal")) + " Taka Only.");
        t.setTextColor(Ui.TEXT);
        t.setTextSize(10.5f);
        box.addView(t);
        return box;
    }

    private static View totals(Context c, Map<String, Object> m) {
        LinearLayout box = Ui.col(c);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(Ui.dp(c, 190),
                ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(Ui.dp(c, 10), 0, 0, 0);
        box.setLayoutParams(lp);

        box.addView(totalRow(c, "Total Qty", Store.qty(m.get("totalQty")), 0, 0, false));
        box.addView(totalRow(c, "Subtotal", Store.money(m.get("subtotal")), 0, 0, false));
        box.addView(totalRow(c, "Discount", "- " + Store.money(m.get("discount")), 0, 0, false));
        box.addView(totalRow(c, "Delivery Charge", "+ " + Store.money(m.get("deliveryCharge")),
                0, 0, false));
        if (Store.num(m.get("vat")) != 0) {
            box.addView(totalRow(c, "VAT", "+ " + Store.money(m.get("vat")), 0, 0, false));
        }
        box.addView(totalRow(c, "Grand Total", Store.money(m.get("grandTotal")),
                Color.WHITE, NAVY, true));
        box.addView(totalRow(c, "Advance", "- " + Store.money(m.get("advance")), 0, 0, false));
        box.addView(totalRow(c, "Due", Store.money(m.get("due")), DUE, DUE_BG, true));
        return box;
    }

    private static View totalRow(Context c, String label, String value, int color, int bg,
                                 boolean bold) {
        LinearLayout r = Ui.row(c);
        if (bg != 0) r.setBackgroundColor(bg);
        int p = Ui.dp(c, 5);
        r.setPadding(p, p, p, p);
        TextView l = new TextView(c);
        l.setText(label);
        l.setTextColor(bold && bg == DUE_BG ? 0xFF8A1240 : (bold ? Color.WHITE : Ui.TEXT));
        l.setTextSize(bold ? 11.5f : 10.5f);
        if (bold) l.setTypeface(Typeface.DEFAULT_BOLD);
        l.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView v = new TextView(c);
        v.setText(value);
        v.setTextColor(color == 0 ? Ui.TEXT : color);
        v.setTextSize(bold ? 12.5f : 10.5f);
        v.setGravity(Gravity.END);
        if (bold) v.setTypeface(Typeface.DEFAULT_BOLD);
        r.addView(l);
        r.addView(v);
        return r;
    }

    private static View signatures(Context c) {
        LinearLayout row = Ui.row(c);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, Ui.dp(c, 36), 0, 0);
        row.setLayoutParams(lp);
        row.addView(signLine(c, "Customer Signature"));
        row.addView(signLine(c, "Authorized Signature"));
        return row;
    }

    private static View signLine(Context c, String label) {
        LinearLayout col = Ui.col(c);
        col.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(Ui.dp(c, 12), 0, Ui.dp(c, 12), 0);
        col.setLayoutParams(lp);
        View rule = new View(c);
        rule.setBackgroundColor(Ui.TEXT);
        rule.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, Ui.dp(c, 1))));
        TextView t = new TextView(c);
        t.setText(label);
        t.setTextColor(MUTED);
        t.setTextSize(10f);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, Ui.dp(c, 4), 0, 0);
        col.addView(rule);
        col.addView(t);
        return col;
    }

    private static View thanks(Context c) {
        TextView t = new TextView(c);
        t.setText(Store.MEMO_THANKS);
        t.setTextColor(MUTED);
        t.setTextSize(10f);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, Ui.dp(c, 12), 0, 0);
        return t;
    }

    /* ------------------------------------------------------- drawables */

    private static GradientDrawable rounded(Context c, int fill, float[] corners) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        if (corners != null) {
            float[] r = new float[corners.length];
            for (int i = 0; i < corners.length; i++) r[i] = Ui.dp(c, (int) corners[i]);
            d.setCornerRadii(r);
        }
        return d;
    }

    private static GradientDrawable bordered(Context c, int fill) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setStroke(Math.max(1, Ui.dp(c, 1)), LINE);
        return d;
    }

    /* ------------------------------------------------------ shareable */

    /** The sheet drawn onto a bitmap, which is what gets sent as a PNG. */
    static Bitmap toBitmap(View sheet, int widthPx) {
        sheet.measure(View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int h = Math.max(1, sheet.getMeasuredHeight());
        Bitmap bmp = Bitmap.createBitmap(widthPx, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        cv.drawColor(Color.WHITE);
        sheet.layout(0, 0, widthPx, h);
        sheet.draw(cv);
        return bmp;
    }

    /** The same bitmap on one A4-ish PDF page, so the memo can be filed as a PDF. */
    static android.graphics.pdf.PdfDocument toPdf(Bitmap bmp, int widthPt, int heightPt) {
        android.graphics.pdf.PdfDocument doc = new android.graphics.pdf.PdfDocument();
        android.graphics.pdf.PdfDocument.PageInfo info =
                new android.graphics.pdf.PdfDocument.PageInfo.Builder(widthPt, heightPt, 1).create();
        android.graphics.pdf.PdfDocument.Page page = doc.startPage(info);
        Canvas cv = page.getCanvas();
        cv.drawColor(Color.WHITE);
        float scale = Math.min((float) widthPt / bmp.getWidth(), (float) heightPt / bmp.getHeight());
        float w = bmp.getWidth() * scale, h = bmp.getHeight() * scale;
        cv.drawBitmap(bmp, null, new android.graphics.RectF((widthPt - w) / 2,
                (heightPt - h) / 2, (widthPt + w) / 2, (heightPt + h) / 2), null);
        doc.finishPage(page);
        return doc;
    }
}
