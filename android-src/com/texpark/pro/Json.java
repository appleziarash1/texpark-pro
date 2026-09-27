package com.texpark.pro;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The smallest JSON reader/writer that can round-trip this app's data.
 *
 * The app's whole database is one JSON document, and it has to survive a trip
 * through the owner's Google Sheet and back, so the encoder must be exact rather
 * than pretty: numbers that came in as integers must go out as integers (a memo
 * total of 2400 becoming 2400.0 is not wrong, but it reads as corrupt in a
 * spreadsheet and will not equal a freshly computed total later).
 *
 * No Android imports on purpose: this runs on a plain JVM in the tests, the same
 * way SiteUrl did.
 */
public final class Json {

    private Json() {}

    /* ------------------------------------------------------------ writing */

    public static String write(Object v) {
        StringBuilder sb = new StringBuilder();
        writeTo(sb, v);
        return sb.toString();
    }

    private static void writeTo(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            writeString(sb, (String) v);
        } else if (v instanceof Boolean) {
            sb.append(((Boolean) v) ? "true" : "false");
        } else if (v instanceof Double || v instanceof Float) {
            writeNumber(sb, ((Number) v).doubleValue());
        } else if (v instanceof Number) {
            sb.append(((Number) v).longValue());
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                writeTo(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object o : (List<?>) v) {
                if (!first) sb.append(',');
                first = false;
                writeTo(sb, o);
            }
            sb.append(']');
        } else {
            writeString(sb, String.valueOf(v));
        }
    }

    /**
     * Whole doubles print without a decimal point. 2400.0 -> 2400, but 2400.5
     * keeps its digits, so a rate of 145.5 is not rounded away by the encoder.
     */
    private static void writeNumber(StringBuilder sb, double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) {
            sb.append('0');           // JSON has no NaN; a corrupt figure must not poison the file
            return;
        }
        if (d == Math.rint(d) && Math.abs(d) < 1e15) {
            sb.append(Long.toString((long) d));
        } else {
            sb.append(trim(Double.toString(d)));
        }
    }

    private static String trim(String s) {
        if (s.indexOf('.') < 0 || s.indexOf('e') >= 0 || s.indexOf('E') >= 0) return s;
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '0') end--;
        if (end > 0 && s.charAt(end - 1) == '.') end--;
        return s.substring(0, end);
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                default:
                    /* Bangla product names are normal here and must travel as
                       themselves; only real control characters get escaped. */
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    /* ------------------------------------------------------------ reading */

    public static Object read(String text) {
        if (text == null) return null;
        P p = new P(text);
        p.ws();
        if (p.i >= p.s.length()) return null;
        Object v = p.value();
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> obj(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : new LinkedHashMap<String, Object>();
    }

    @SuppressWarnings("unchecked")
    public static List<Object> arr(Object v) {
        return v instanceof List ? (List<Object>) v : new ArrayList<Object>();
    }

    private static final class P {
        final String s;
        int i;

        P(String s) { this.s = s; }

        void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        Object value() {
            ws();
            if (i >= s.length()) return null;
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i))  { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i))  { i += 4; return null; }
            return number();
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            i++;                                    // {
            ws();
            if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
            while (i < s.length()) {
                ws();
                if (i < s.length() && s.charAt(i) == '}') { i++; break; }
                String k = string();
                ws();
                if (i < s.length() && s.charAt(i) == ':') i++;
                m.put(k, value());
                ws();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == '}') { i++; break; }
                break;                              // malformed tail: keep what parsed
            }
            return m;
        }

        List<Object> array() {
            List<Object> a = new ArrayList<Object>();
            i++;                                    // [
            ws();
            if (i < s.length() && s.charAt(i) == ']') { i++; return a; }
            while (i < s.length()) {
                a.add(value());
                ws();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == ']') { i++; break; }
                break;
            }
            return a;
        }

        String string() {
            StringBuilder sb = new StringBuilder();
            if (i < s.length() && s.charAt(i) == '"') i++;
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') break;
                if (c != '\\') { sb.append(c); continue; }
                if (i >= s.length()) break;
                char e = s.charAt(i++);
                switch (e) {
                    case '"':  sb.append('"');  break;
                    case '\\': sb.append('\\'); break;
                    case '/':  sb.append('/');  break;
                    case 'n':  sb.append('\n'); break;
                    case 'r':  sb.append('\r'); break;
                    case 't':  sb.append('\t'); break;
                    case 'b':  sb.append('\b'); break;
                    case 'f':  sb.append('\f'); break;
                    case 'u':
                        if (i + 4 <= s.length()) {
                            try {
                                sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            } catch (NumberFormatException ignored) { }
                            i += 4;
                        }
                        break;
                    default: sb.append(e);
                }
            }
            return sb.toString();
        }

        Object number() {
            int start = i;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || (c >= '0' && c <= '9')) i++;
                else break;
            }
            String t = s.substring(start, i);
            if (t.isEmpty()) { i++; return null; }   // step over the offending char
            try {
                double d = Double.parseDouble(t);
                if (d == Math.rint(d) && t.indexOf('.') < 0 && t.indexOf('e') < 0 && t.indexOf('E') < 0
                        && Math.abs(d) < 9.007199254740992E15) {
                    return Long.valueOf((long) d);
                }
                return Double.valueOf(d);
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }
}
