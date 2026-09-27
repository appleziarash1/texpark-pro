package com.texpark.pro;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * View helpers, so every screen is built the same way.
 *
 * Layouts are built in code rather than XML on purpose: the build is javac + d8 +
 * aapt2 with no Gradle, and a layout resource would need the resource compiler to
 * know every id before the Java that binds to it. Building views in Java keeps the
 * whole app compilable by javac alone.
 *
 * Everything is sized for a phone held in one hand: the owner runs this on a
 * handset in the shop, not on a desktop.
 */
public final class Ui {

    public static final int NAVY = 0xFF12366B;
    public static final int PINK = 0xFFE0426A;
    public static final int BG = 0xFFF2F4F7;
    public static final int CARD = 0xFFFFFFFF;
    public static final int TEXT = 0xFF1B2430;
    public static final int MUTED = 0xFF6B7684;
    public static final int GREEN = 0xFF1F8A4C;
    public static final int RED = 0xFFC62828;
    public static final int AMBER = 0xFFB26A00;

    private Ui() {}

    public static int dp(Context c, int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                c.getResources().getDisplayMetrics());
    }

    public static LinearLayout col(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    /** A screen body: scrollable, padded, on the app background. */
    public static ScrollView scroller(Context c, LinearLayout body) {
        ScrollView s = new ScrollView(c);
        s.setBackgroundColor(BG);
        s.setFillViewport(true);
        int p = dp(c, 12);
        body.setPadding(p, p, p, dp(c, 32));
        s.addView(body, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return s;
    }

    /** A white card with a heading, which is the unit every screen is made of. */
    public static LinearLayout card(Context c, String title) {
        LinearLayout card = col(c);
        card.setBackgroundColor(CARD);
        int p = dp(c, 12);
        card.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 0, dp(c, 10));
        card.setLayoutParams(lp);
        if (title != null && !title.isEmpty()) {
            TextView t = new TextView(c);
            t.setText(title);
            t.setTextColor(NAVY);
            t.setTextSize(15f);
            t.setTypeface(Typeface.DEFAULT_BOLD);
            t.setPadding(0, 0, 0, dp(c, 6));
            card.addView(t);
        }
        return card;
    }

    public static TextView label(Context c, String text) {
        TextView t = new TextView(c);
        t.setText(text);
        t.setTextColor(MUTED);
        t.setTextSize(12.5f);
        t.setPadding(0, dp(c, 4), 0, dp(c, 2));
        return t;
    }

    /** Big figure for the dashboard, with its caption underneath. */
    public static LinearLayout kpi(Context c, String value, String caption, int color) {
        LinearLayout box = col(c);
        box.setBackgroundColor(CARD);
        int p = dp(c, 10);
        box.setPadding(p, p, p, p);
        TextView v = new TextView(c);
        v.setText(value);
        v.setTextColor(color);
        v.setTextSize(19f);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        TextView cp = new TextView(c);
        cp.setText(caption);
        cp.setTextColor(MUTED);
        cp.setTextSize(11.5f);
        box.addView(v);
        box.addView(cp);
        return box;
    }

    public static EditText field(Context c, String hint, String value, int inputType) {
        EditText e = new EditText(c);
        e.setHint(hint);
        if (value != null) e.setText(value);
        e.setTextSize(14f);
        e.setTextColor(TEXT);
        e.setHintTextColor(MUTED);
        e.setInputType(inputType);
        e.setBackgroundColor(0xFFF7F9FB);
        int p = dp(c, 9);
        e.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 0, dp(c, 6));
        e.setLayoutParams(lp);
        return e;
    }

    public static EditText number(Context c, String hint, String value) {
        EditText e = field(c, hint, value, android.text.InputType.TYPE_CLASS_NUMBER
                | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL);
        e.setGravity(Gravity.END);
        return e;
    }

    public static Button button(Context c, String text, int bg) {
        Button b = new Button(c);
        b.setText(text);
        b.setTextSize(13.5f);
        b.setAllCaps(false);
        b.setTextColor(bg == CARD ? NAVY : Color.WHITE);
        b.setBackgroundColor(bg);
        b.setPadding(dp(c, 8), dp(c, 4), dp(c, 8), dp(c, 4));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, dp(c, 6), 0);
        b.setLayoutParams(lp);
        b.setMinWidth(dp(c, 64));
        return b;
    }

    public static Button primary(Context c, String text) { return button(c, text, NAVY); }

    public static Button ghost(Context c, String text) {
        Button b = button(c, text, 0xFFE3E9F1);
        b.setTextColor(NAVY);
        return b;
    }

    /** A table-ish row: fixed-width cells so columns line up down the card. */
    public static LinearLayout cells(Context c, String[] values, float[] weights, int color,
                                     boolean bold) {
        LinearLayout r = row(c);
        r.setPadding(0, dp(c, 3), 0, dp(c, 3));
        for (int i = 0; i < values.length; i++) {
            TextView t = new TextView(c);
            t.setText(values[i] == null ? "" : values[i]);
            t.setTextColor(color);
            t.setTextSize(12.5f);
            if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    i < weights.length ? weights[i] : 1f);
            t.setLayoutParams(lp);
            r.addView(t);
        }
        return r;
    }

    public static View divider(Context c) {
        View v = new View(c);
        v.setBackgroundColor(0xFFE6EAF0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(c, 1)));
        lp.setMargins(0, dp(c, 4), 0, dp(c, 4));
        v.setLayoutParams(lp);
        return v;
    }

    /** Puts KPI boxes on one row, sharing the width evenly. */
    public static LinearLayout kpiRow(Context c, LinearLayout... boxes) {
        LinearLayout r = row(c);
        for (LinearLayout b : boxes) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            lp.setMargins(0, 0, dp(c, 6), dp(c, 6));
            b.setLayoutParams(lp);
            r.addView(b);
        }
        return r;
    }

    public static String money(Object v) {
        double n = Store.num(v);
        boolean neg = n < 0;
        n = Math.abs(n);
        String s = String.format(java.util.Locale.US, "%,.2f", n);
        if (s.endsWith(".00")) s = s.substring(0, s.length() - 3);
        return (neg ? "-" : "") + "\u09F3" + s;
    }

    public static String qty(Object v) {
        double n = Store.num(v);
        if (n == Math.rint(n)) return String.valueOf((long) n);
        return String.format(java.util.Locale.US, "%.2f", n);
    }

    public static String date(Object v) {
        String s = v == null ? "" : String.valueOf(v);
        return s.isEmpty() ? "-" : s;
    }
}
