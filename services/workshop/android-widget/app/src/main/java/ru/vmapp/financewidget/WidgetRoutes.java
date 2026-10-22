package ru.vmapp.financewidget;

final class WidgetRoutes {
    static final String APP_URL = "https://vm-app.ru/";
    static final String EXPENSE = APP_URL + "?action=expense";
    static final String INCOME = APP_URL + "?action=income";
    static final String PRODUCTION = APP_URL + "?action=production";
    static final String WAREHOUSE = APP_URL + "#warehouse";
    static final String ORDERS = APP_URL + "kanban/";
    static final String CLIENTS = APP_URL + "crm/";

    private WidgetRoutes() {}

    static int requestCode(int widgetId, int actionCode) {
        return widgetId * 100 + actionCode;
    }

    static String[] all() {
        return new String[] {APP_URL, EXPENSE, INCOME, PRODUCTION, WAREHOUSE, ORDERS, CLIENTS};
    }
}
