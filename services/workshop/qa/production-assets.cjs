const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const fs = require('node:fs');
void (async () => {
  const browser = await chromium.launch({
    executablePath:
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 600 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    '<html lang="ru"><body style="margin:0;background:#f2f1e8;font-family:Segoe UI,sans-serif;color:#24342a"><div style="padding:44px"><div style="font-size:16px;letter-spacing:2px">УЧЕБНЫЙ ЗАКАЗ · СОГЛАСОВАННЫЙ МАКЕТ</div><div style="margin-top:70px;border:1px solid #a3ad9a;border-radius:8px;padding:45px;text-align:center;font-size:96px;letter-spacing:20px;color:#486333">ЛУНА</div><div style="margin-top:50px;display:flex;justify-content:space-between;font-size:18px"><span>Объёмные буквы на рамке</span><span>Вымышленный пример · версия 1</span></div></div></body></html>',
  );
  fs.mkdirSync('qa/assets', { recursive: true });
  await page.screenshot({ path: 'qa/assets/production-letters.png' });
  await browser.close();
})();
