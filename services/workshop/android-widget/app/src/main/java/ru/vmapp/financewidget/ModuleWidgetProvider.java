package ru.vmapp.financewidget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

public final class ModuleWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            updateWidget(context, manager, widgetId);
        }
    }

    @Override
    public void onDeleted(Context context, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            ModuleWidgetPreferences.delete(context, widgetId);
        }
    }

    @Override
    public void onRestored(Context context, int[] oldWidgetIds, int[] newWidgetIds) {
        int count = Math.min(oldWidgetIds.length, newWidgetIds.length);
        for (int index = 0; index < count; index++) {
            ModuleWidgetPreferences.move(context, oldWidgetIds[index], newWidgetIds[index]);
        }
    }

    static void updateWidget(Context context, AppWidgetManager manager, int widgetId) {
        String module = ModuleWidgetPreferences.get(context, widgetId);
        int icon;
        int title;
        int description;
        int actionCode;
        String url;

        switch (module) {
            case ModuleWidgetPreferences.ORDERS:
                icon = R.drawable.ic_orders;
                title = R.string.module_orders;
                description = R.string.module_orders_description;
                actionCode = 32;
                url = WidgetRoutes.ORDERS;
                break;
            case ModuleWidgetPreferences.PRODUCTION:
                icon = R.drawable.ic_production;
                title = R.string.module_production;
                description = R.string.module_production_description;
                actionCode = 33;
                url = WidgetRoutes.PRODUCTION;
                break;
            case ModuleWidgetPreferences.WAREHOUSE:
                icon = R.drawable.ic_warehouse;
                title = R.string.module_warehouse;
                description = R.string.module_warehouse_description;
                actionCode = 34;
                url = WidgetRoutes.WAREHOUSE;
                break;
            default:
                icon = R.drawable.ic_dashboard;
                title = R.string.module_finance;
                description = R.string.module_finance_description;
                actionCode = 31;
                url = WidgetRoutes.APP_URL;
                break;
        }

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.module_widget);
        views.setImageViewResource(R.id.module_icon, icon);
        views.setTextViewText(R.id.module_title, context.getString(title));
        views.setContentDescription(R.id.module_root, context.getString(description));
        WidgetActions.bind(views, R.id.module_root, context, widgetId, actionCode, url);
        manager.updateAppWidget(widgetId, views);
    }
}
