package com.texpark.pro;

import java.util.Locale;
import java.util.Map;

/**
 * Turns one spoken sentence into a decision the app can act on.
 *
 * Kept free of Android imports so it can be tested on a plain JVM. That matters
 * more here than on any other screen: this is the one place where a slip does not
 * merely look wrong - mis-reading "Kids 3pcs 5 piece" could move stock or put the
 * wrong item on a memo. The speech recogniser itself cannot be tested off-device,
 * but everything between its text and the database can, and that is where the
 * mistakes would live.
 *
 * The grammar is deliberately small and forgiving. The shop's products have roman
 * names, but a bn-BD phone dictates Bangla script, so the trigger words cover both
 * and the product is matched by name or SKU against products that actually exist -
 * never invented from the sentence.
 */
public final class Voice {

    private Voice() {}

    /** "the goods came in" in both the roman and the Bangla the shop would say. */
    private static final String[] IN_WORDS = {
        "in hoise", "in hoyeche", "in holo", "ashlo", "ashe", "ashche", "elo", "elom",
        "received", "receive", "tola", "stock",
        "\u0995\u09CD\u09B0\u09AF\u09BC", "\u0995\u09BF\u09A8\u09B2\u09BE\u09AE",
        "\u0986\u09B8\u09B2\u09CB", "\u09AE\u09BE\u09B2"
    };

    /** "the goods went out". */
    private static final String[] OUT_WORDS = {
        "sell", "sold", "bikri", "bech", "bechlam", "memo", "delivery", "chole gelo",
        "gelo", "\u09AC\u09BF\u0995\u09CD\u09B0\u09BF", "\u09AC\u09C7\u099A",
        "\u099A\u09B2\u09C7 \u0997\u09C7\u09B2\u09CB", "\u09AE\u09C7\u09AE\u09CB"
    };

    /** What the sentence asked for. UNKNOWN means say so rather than guess. */
    public enum Intent { RECEIPT, SALE, UNKNOWN }

    /** The result of reading a sentence: a product, a quantity and what to do. */
    public static final class Reading {
        public Intent intent = Intent.UNKNOWN;
        public Map<String, Object> product;      // null when nothing matched
        public String productName = "";
        public double qty;
        public String heard = "";

        public boolean ok() { return product != null && qty > 0; }
    }

    public static String normalise(String text) {
        return text == null ? "" : text.toLowerCase(Locale.US).trim();
    }

    /**
     * Reads a sentence against the products that exist.
     *
     * Matching is by the product's own words rather than its whole name, because a
     * shop says "kids 3pcs 5 piece ashlo" and not "Kids 3pcs Set". Two details make
     * that safe:
     *
     *  - The matched product's words are removed from the sentence before the
     *    quantity is read. Without this, "Kids 3pcs" contributes a 3 and a genuine
     *    "5 piece" is lost - a wrong quantity is worse than no answer.
     *  - A tie between two products refusing to guess. "kids ashlo 5" matches both
     *    a "Kids 3pcs Set" and a "Kids Girls Sweater"; picking either would
     *    silently move stock for the wrong item.
     */
    public static Reading read(Store store, String text) {
        Reading r = new Reading();
        r.heard = text == null ? "" : text;
        String low = normalise(text);

        boolean in = containsAny(low, IN_WORDS);
        boolean out = containsAny(low, OUT_WORDS);
        r.intent = in && !out ? Intent.RECEIPT : (out ? Intent.SALE : Intent.UNKNOWN);

        // Score every product by how many of its own words the sentence contains.
        int bestScore = 0;
        int winners = 0;
        Map<String, Object> best = null;
        for (Object o : store.list("products")) {
            Map<String, Object> p = Store.rec(o);
            int score = 0;
            for (String token : tokens(Store.str(p, "name"))) {
                if (hasWord(low, token)) score++;
            }
            if (score == 0) continue;
            if (score > bestScore) {
                bestScore = score;
                best = p;
                winners = 1;
            } else if (score == bestScore) {
                winners++;
            }
        }
        if (bestScore > 1 && winners == 1) {
            r.product = best;
        } else if (bestScore == 1 && winners == 1) {
            r.product = best;
        } else if (bestScore >= 1) {
            r.product = null;                     // a tie: do not guess which item
            r.productName = "ekadhik product";
            r.qty = 0;
            return r;
        }

        if (r.product == null) {
            // No name word matched; fall back to the SKU, which is short, unique and
            // how the owner says an item when the name is awkward to pronounce.
            for (Object o : store.list("products")) {
                Map<String, Object> p = Store.rec(o);
                String sku = normalise(Store.str(p, "sku"));
                if (!sku.isEmpty() && hasWord(low, sku)) {
                    r.product = p;
                    break;
                }
            }
        }
        if (r.product == null) return r;

        r.productName = Store.str(r.product, "name");

        /* Read the quantity from a sentence with the product's own words taken out,
           so the digits inside a name ("3pcs") cannot be mistaken for the quantity. */
        String rest = low;
        for (String token : tokens(Store.str(r.product, "name"))) {
            rest = rest.replaceAll("(?<!\\p{Alnum})" + java.util.regex.Pattern.quote(token)
                    + "(?!\\p{Alnum})", " ");
        }
        String sku = normalise(Store.str(r.product, "sku"));
        if (!sku.isEmpty()) {
            rest = rest.replaceAll("(?<!\\p{Alnum})" + java.util.regex.Pattern.quote(sku)
                    + "(?!\\p{Alnum})", " ");
        }

        r.qty = firstNumber(rest);
        if (r.qty <= 0 && r.intent == Intent.RECEIPT) r.qty = 1;
        return r;
    }

    /** A name's meaningful words: letters and digits, lowercased, short ones kept
     *  because "3pcs" is what distinguishes one kids set from another. */
    static java.util.List<String> tokens(String name) {
        java.util.List<String> out = new java.util.ArrayList<String>();
        if (name == null) return out;
        for (String t : name.toLowerCase(Locale.US).split("[^\\p{Alnum}]+")) {
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    /** Whether the sentence contains this word as a word, not inside a longer one.
     *  Plain contains() would let the SKU "BK" match the middle of "bKash". */
    public static boolean hasWord(String hay, String word) {
        if (word == null || word.isEmpty()) return false;
        return java.util.regex.Pattern
                .compile("(?<!\\p{Alnum})" + java.util.regex.Pattern.quote(word) + "(?!\\p{Alnum})")
                .matcher(hay).find();
    }

    public static boolean containsAny(String hay, String[] words) {
        for (String w : words) if (hay.contains(w)) return true;
        return false;
    }

    /** The first number in the sentence, Bangla digits folded to ASCII first.
     *  Bangla phones relay stock numbers as ০..৯ as often as 0..9. */
    public static double firstNumber(String text) {
        StringBuilder sb = new StringBuilder();
        String low = text == null ? "" : text;
        for (int i = 0; i < low.length(); i++) {
            char c = low.charAt(i);
            if (c >= '0' && c <= '9') {
                sb.append(c);
            } else if (c >= '\u09E6' && c <= '\u09EF') {        // ০..৯
                sb.append((char) ('0' + (c - '\u09E6')));
            } else if (c == '.' && sb.length() > 0) {
                sb.append(c);
            } else if (sb.length() > 0) {
                break;                                           // the number ended
            }
        }
        return Store.num(sb.toString());
    }
}
