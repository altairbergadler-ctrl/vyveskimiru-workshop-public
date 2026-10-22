import { useCallback, useEffect, useRef, useState } from 'react';

export type WidgetSource<T> = {
  data: T | null;
  error: string;
  loading: boolean;
  updatedAt: string;
  refresh: () => void;
};

export function useWidgetSource<T>(
  url: string,
  field: string,
  enabled: boolean,
  revision = 0,
): WidgetSource<T> {
  const [state, setState] = useState({
    data: null as T | null,
    error: '',
    loading: true,
    updatedAt: '',
  });
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const lastAttempt = useRef(0);
  const refresh = useCallback(async () => {
    if (pending.current || !mounted.current) return;
    const controller = new AbortController();
    pending.current = controller;
    lastAttempt.current = Date.now();
    const timeout = window.setTimeout(() => controller.abort(), 25_000);
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data[field]))
        throw new Error(
          response.status === 401
            ? 'Сессия закончилась. Войдите снова.'
            : data.error || 'Не удалось обновить данные',
        );
      if (mounted.current && pending.current === controller)
        setState({
          data,
          loading: false,
          error: '',
          updatedAt:
            data.updatedAt || data.refreshedAt || new Date().toISOString(),
        });
    } catch (error) {
      if (mounted.current && pending.current === controller)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: controller.signal.aborted
            ? 'Источник не ответил вовремя'
            : error instanceof TypeError
              ? 'Нет связи с источником. Проверьте подключение и обновите виджет.'
              : error instanceof Error
                ? error.message
                : 'Не удалось обновить данные',
        }));
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    }
  }, [url, field]);
  useEffect(() => {
    mounted.current = true;
    if (!enabled)
      return () => {
        mounted.current = false;
      };
    queueMicrotask(() => {
      void refresh();
    });
    const visibleRefresh = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastAttempt.current > 30_000
      )
        void refresh();
    };
    const timer = window.setInterval(visibleRefresh, 60_000);
    window.addEventListener('focus', visibleRefresh);
    window.addEventListener('online', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      pending.current?.abort();
      pending.current = null;
      window.removeEventListener('focus', visibleRefresh);
      window.removeEventListener('online', visibleRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [enabled, refresh, revision]);
  return {
    ...state,
    refresh: () => {
      void refresh();
    },
  };
}
