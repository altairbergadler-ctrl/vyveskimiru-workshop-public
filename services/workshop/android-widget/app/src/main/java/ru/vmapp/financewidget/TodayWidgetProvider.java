package ru.vmapp.financewidget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

public final class TodayWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.today_widget);
            WidgetActions.bind(views, R.id.today_orders, context, widgetId, 21, WidgetRoutes.ORDERS);
            WidgetActions.bind(views, R.id.today_production, context, widgetId, 22, WidgetRoutes.PRODUCTION);
            WidgetActions.bind(views, R.id.today_warehouse, context, widgetId, 23, WidgetRoutes.WAREHOUSE);
            manager.updateAppWidget(widgetId, views);
        }
    }
}
