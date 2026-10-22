package ru.vmapp.financewidget;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

final class WidgetActions {
    private WidgetActions() {}

    static void bind(
        RemoteViews views,
        int viewId,
        Context context,
        int widgetId,
        int actionCode,
        String url
    ) {
        if (!url.startsWith(WidgetRoutes.APP_URL)) {
            throw new IllegalArgumentException("Widget links must stay on vm-app.ru");
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            WidgetRoutes.requestCode(widgetId, actionCode),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(viewId, pendingIntent);
    }
}
