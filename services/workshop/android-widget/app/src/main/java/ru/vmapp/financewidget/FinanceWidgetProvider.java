package ru.vmapp.financewidget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

public final class FinanceWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        for (int widgetId : widgetIds) {
            manager.updateAppWidget(widgetId, createViews(context, widgetId));
        }
    }

    static RemoteViews createViews(Context context, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.finance_widget);
        WidgetActions.bind(views, R.id.action_expense, context, widgetId, 1, WidgetRoutes.EXPENSE);
        WidgetActions.bind(views, R.id.action_income, context, widgetId, 2, WidgetRoutes.INCOME);
        WidgetActions.bind(views, R.id.action_production, context, widgetId, 3, WidgetRoutes.PRODUCTION);
        WidgetActions.bind(views, R.id.action_warehouse, context, widgetId, 4, WidgetRoutes.WAREHOUSE);
        return views;
    }
}
