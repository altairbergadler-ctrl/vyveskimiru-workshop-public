package ru.vmapp.financewidget;

import android.app.Activity;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(createContent());
    }

    private View createContent() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(24), dp(36), dp(24), dp(32));
        root.setBackgroundColor(Color.rgb(248, 246, 240));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));

        TextView mark = new TextView(this);
        mark.setText("↗");
        mark.setTextSize(28);
        mark.setGravity(Gravity.CENTER);
        mark.setTextColor(Color.rgb(23, 27, 24));
        mark.setBackgroundResource(R.drawable.launcher_badge);
        root.addView(mark, new LinearLayout.LayoutParams(dp(64), dp(64)));

        TextView title = new TextView(this);
        title.setText(R.string.setup_title);
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setTextColor(Color.rgb(23, 27, 24));
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = matchWrap();
        titleParams.setMargins(0, dp(24), 0, 0);
        root.addView(title, titleParams);

        TextView description = new TextView(this);
        description.setText(R.string.setup_description);
        description.setTextSize(16);
        description.setTextColor(Color.rgb(87, 95, 89));
        description.setGravity(Gravity.CENTER);
        description.setLineSpacing(0, 1.2f);
        LinearLayout.LayoutParams descriptionParams = matchWrap();
        descriptionParams.setMargins(0, dp(12), 0, dp(22));
        root.addView(description, descriptionParams);

        addVariantButton(
            root,
            R.string.widget_quick_button,
            R.drawable.ic_income,
            FinanceWidgetProvider.class,
            201,
            true
        );
        addVariantButton(
            root,
            R.string.widget_today_button,
            R.drawable.ic_today,
            TodayWidgetProvider.class,
            202,
            false
        );
        addVariantButton(
            root,
            R.string.widget_pulse_button,
            R.drawable.ic_dashboard,
            PulseWidgetProvider.class,
            203,
            false
        );
        addVariantButton(
            root,
            R.string.widget_module_button,
            R.drawable.ic_module,
            ModuleWidgetProvider.class,
            204,
            false
        );

        Button openPwa = new Button(this);
        openPwa.setText(R.string.open_pwa);
        openPwa.setAllCaps(false);
        openPwa.setTextSize(15);
        openPwa.setTextColor(Color.rgb(23, 27, 24));
        openPwa.setBackgroundResource(R.drawable.secondary_button);
        openPwa.setOnClickListener(view -> openPwa());
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(-1, dp(52));
        openParams.setMargins(0, dp(4), 0, 0);
        root.addView(openPwa, openParams);

        TextView privacy = new TextView(this);
        privacy.setText(R.string.privacy_note);
        privacy.setTextSize(12);
        privacy.setTextColor(Color.rgb(117, 123, 119));
        privacy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams privacyParams = matchWrap();
        privacyParams.setMargins(0, dp(24), 0, 0);
        root.addView(privacy, privacyParams);

        return scroll;
    }

    private void addVariantButton(
        LinearLayout root,
        int text,
        int icon,
        Class<?> providerClass,
        int requestCode,
        boolean primary
    ) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setTextColor(Color.rgb(23, 27, 24));
        button.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        button.setCompoundDrawablesWithIntrinsicBounds(icon, 0, 0, 0);
        button.setCompoundDrawablePadding(dp(14));
        button.setBackgroundResource(primary ? R.drawable.primary_button : R.drawable.secondary_button);
        button.setOnClickListener(view -> requestWidgetPin(providerClass, requestCode));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(68));
        params.setMargins(0, 0, 0, dp(10));
        root.addView(button, params);
    }

    private void requestWidgetPin(Class<?> providerClass, int requestCode) {
        AppWidgetManager manager = AppWidgetManager.getInstance(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.isRequestPinAppWidgetSupported()) {
            ComponentName provider = new ComponentName(this, providerClass);
            PendingIntent callback = null;
            if (providerClass == ModuleWidgetProvider.class) {
                Intent callbackIntent = new Intent(this, ModuleWidgetConfigureActivity.class);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_ONE_SHOT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    flags |= PendingIntent.FLAG_MUTABLE;
                }
                callback = PendingIntent.getActivity(
                    this,
                    requestCode,
                    callbackIntent,
                    flags
                );
            }
            if (!manager.requestPinAppWidget(provider, null, callback)) {
                Toast.makeText(this, R.string.add_manually, Toast.LENGTH_LONG).show();
            }
        } else {
            Toast.makeText(this, R.string.add_manually, Toast.LENGTH_LONG).show();
        }
    }

    private void openPwa() {
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(WidgetRoutes.APP_URL)));
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(-1, -2);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
