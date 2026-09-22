package com.texpark.pro;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Turning what the owner types into a usable site address.
 *
 * Kept apart from MainActivity and free of Android types so it can be compiled
 * and tested on a plain JVM - this is the one place a typo sends the whole app
 * to a dead page, so it is the one place worth testing hard.
 */
public final class SiteUrl {

    private SiteUrl() {
    }

    /**
     * @return a https address with no trailing slash, or null when the input is
     *         not a usable host.
     */
    public static String normalise(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        if (s.indexOf(' ') >= 0) return null;

        if (s.startsWith("http://")) {
            s = "https://" + s.substring("http://".length());
        } else if (!s.startsWith("https://")) {
            s = "https://" + s;
        }

        String host;
        try {
            URI u = new URI(s);
            host = u.getHost();
        } catch (URISyntaxException e) {
            return null;
        }
        if (host == null || host.isEmpty()) return null;
        if (host.indexOf('.') < 0) return null;
        if (host.startsWith(".") || host.endsWith(".")) return null;

        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }
}