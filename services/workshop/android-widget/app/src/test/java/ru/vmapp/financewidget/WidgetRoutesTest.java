package ru.vmapp.financewidget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.net.URI;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public final class WidgetRoutesTest {
    @Test
    public void everyRouteUsesHttpsOnVmApp() throws Exception {
        for (String route : WidgetRoutes.all()) {
            URI uri = new URI(route);
            assertEquals("https", uri.getScheme());
            assertEquals("vm-app.ru", uri.getHost());
        }
    }

    @Test
    public void routeListHasNoDuplicates() {
        Set<String> routes = new HashSet<>();
        for (String route : WidgetRoutes.all()) {
            assertTrue(routes.add(route));
        }
    }

    @Test
    public void requestCodesSeparateWidgetsAndActions() {
        assertNotEquals(WidgetRoutes.requestCode(41, 1), WidgetRoutes.requestCode(42, 1));
        assertNotEquals(WidgetRoutes.requestCode(41, 1), WidgetRoutes.requestCode(41, 2));
    }
}
