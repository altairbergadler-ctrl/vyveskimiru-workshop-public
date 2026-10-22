package ru.vmapp.financewidget;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class ModuleWidgetConfigureActivity extends Activity {
    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setResult(RESULT_CANCELED);
        widgetId = getIntent().getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID
        );
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }
        AppWidgetProviderInfo widgetInfo = AppWidgetManager.getInstance(this).getAppWidgetInfo(widgetId);
        ComponentName expectedProvider = new ComponentName(this, ModuleWidgetProvider.class);
        if (widgetInfo == null || !expectedProvider.equals(widgetInfo.provider)) {
            finish();
            return;
        }
        setContentView(createContent());
    }

    private View createContent() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(40), dp(24), dp(32));
        root.setBackgroundColor(Color.rgb(248, 246, 240));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));

        TextView title = new TextView(this);
        title.setText(R.string.module_setup_title);
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setTextColor(Color.rgb(23, 27, 24));
        root.addView(title, matchWrap());

        TextView description = new TextView(this);
        description.setText(R.string.module_setup_description);
        description.setTextSize(16);
        description.setTextColor(Color.rgb(87, 95, 89));
        LinearLayout.LayoutParams descriptionParams = matchWrap();
        descriptionParams.setMargins(0, dp(10), 0, dp(22));
        root.addView(description, descriptionParams);

        addChoice(root, R.string.module_finance, R.string.module_finance_description, R.drawable.ic_dashboard, ModuleWidgetPreferences.FINANCE);
        addChoice(root, R.string.module_orders, R.string.module_orders_description, R.drawable.ic_orders, ModuleWidgetPreferences.ORDERS);
        addChoice(root, R.string.module_production, R.string.module_production_description, R.drawable.ic_production, ModuleWidgetPreferences.PRODUCTION);
        addChoice(root, R.string.module_warehouse, R.string.module_warehouse_description, R.drawable.ic_warehouse, ModuleWidgetPreferences.WAREHOUSE);

        TextView privacy = new TextView(this);
        privacy.setText(R.string.privacy_note);
        privacy.setTextSize(12);
        privacy.setTextColor(Color.rgb(117, 123, 119));
        privacy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams privacyParams = matchWrap();
        privacyParams.setMargins(0, dp(20), 0, 0);
        root.addView(privacy, privacyParams);

        return scroll;
    }

    private void addChoice(LinearLayout root, int title, int description, int icon, String module) {
        Button button = new Button(this);
        button.setText(getString(R.string.module_choice_format, getString(title), getString(description)));
        button.setAllCaps(false);
        button.setTextSize(16);
        button.setTextColor(Color.rgb(23, 27, 24));
        button.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        button.setCompoundDrawablesWithIntrinsicBounds(icon, 0, 0, 0);
        button.setCompoundDrawablePadding(dp(14));
        button.setBackgroundResource(R.drawable.secondary_button);
        button.setOnClickListener(view -> complete(module));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(68));
        params.setMargins(0, 0, 0, dp(10));
        root.addView(button, params);
    }

    private void complete(String module) {
        ModuleWidgetPreferences.save(this, widgetId, module);
        ModuleWidgetProvider.updateWidget(this, AppWidgetManager.getInstance(this), widgetId);
        Intent result = new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        setResult(RESULT_OK, result);
        finish();
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(-1, -2);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
