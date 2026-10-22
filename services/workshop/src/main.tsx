import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../app/page';
import ProductionPilot from '../components/production-pilot';
const AnalyticsLive = lazy(() => import('../components/analytics-live'));
import '../app/globals.css';

if (window.location.pathname === '/' && window.location.hash === '#production')
  window.location.replace('/production/');
if (window.location.pathname.startsWith('/production'))
  document.title = 'Производство · Мастерская';

if (window.location.pathname.startsWith('/analytics/live'))
  document.title = 'Авито · Аналитика Мастерской';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {window.location.pathname.startsWith('/analytics/live') ? (
      <Suspense fallback={<p>Загружаем аналитику…</p>}>
        <AnalyticsLive />
      </Suspense>
    ) : window.location.pathname.startsWith('/production') ? (
      <ProductionPilot />
    ) : (
      <Home />
    )}
  </StrictMode>,
);

if (
  'serviceWorker' in navigator &&
  import.meta.env.PROD &&
  !window.location.pathname.startsWith('/production')
) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js?v=43');
  });
}
