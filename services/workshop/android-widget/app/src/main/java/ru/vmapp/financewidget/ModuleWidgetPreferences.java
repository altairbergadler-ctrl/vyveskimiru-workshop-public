package ru.vmapp.financewidget;

import android.content.Context;
import android.content.SharedPreferences;

final class ModuleWidgetPreferences {
    static final String FINANCE = "finance";
    static final String ORDERS = "orders";
    static final String PRODUCTION = "production";
    static final String WAREHOUSE = "warehouse";

    private static final String PREFERENCES = "module_widget_preferences";
    private static final String KEY_PREFIX = "module_";

    private ModuleWidgetPreferences() {}

    static String get(Context context, int widgetId) {
        return normalize(preferences(context).getString(KEY_PREFIX + widgetId, FINANCE));
    }

    static void save(Context context, int widgetId, String module) {
        preferences(context).edit().putString(KEY_PREFIX + widgetId, normalize(module)).apply();
    }

    static void delete(Context context, int widgetId) {
        preferences(context).edit().remove(KEY_PREFIX + widgetId).apply();
    }

    static void move(Context context, int oldWidgetId, int newWidgetId) {
        String module = get(context, oldWidgetId);
        SharedPreferences.Editor editor = preferences(context).edit();
        editor.putString(KEY_PREFIX + newWidgetId, module);
        editor.remove(KEY_PREFIX + oldWidgetId);
        editor.apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static String normalize(String module) {
        if (ORDERS.equals(module) || PRODUCTION.equals(module) || WAREHOUSE.equals(module)) {
            return module;
        }
        return FINANCE;
    }
}
