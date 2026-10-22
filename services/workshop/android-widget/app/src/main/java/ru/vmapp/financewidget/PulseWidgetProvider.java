package ru.vmapp.financewidget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

public final class PulseWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.pulse_widget);
            WidgetActions.bind(views, R.id.pulse_finance, context, widgetId, 11, WidgetRoutes.APP_URL);
            WidgetActions.bind(views, R.id.pulse_orders, context, widgetId, 12, WidgetRoutes.ORDERS);
            WidgetActions.bind(views, R.id.pulse_clients, context, widgetId, 13, WidgetRoutes.CLIENTS);
            WidgetActions.bind(views, R.id.pulse_warehouse, context, widgetId, 14, WidgetRoutes.WAREHOUSE);
            manager.updateAppWidget(widgetId, views);
        }
    }
}
