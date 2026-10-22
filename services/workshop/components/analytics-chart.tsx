import { useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import type { LiveReport } from '../lib/analytics-live';
import { analyticsSeries } from '../lib/analytics-series';
import { responseTime } from '../lib/response-time';

const metrics = [
  ['receipts', 'Поступления', 'money'],
  ['spend', 'Расходы', 'money'],
  ['profit', 'Оценочная прибыль', 'money'],
  ['result', 'Прибыль после рекламы', 'money'],
  ['impressions', 'Показы', 'count'],
  ['views', 'Просмотры', 'count'],
  ['contacts', 'Контакты', 'count'],
  ['orders', 'Заказы', 'count'],
  ['cpc', 'Цена контакта', 'money'],
  ['ctr', 'Показ → просмотр', 'percent'],
  ['conversion', 'Просмотр → контакт', 'percent'],
  ['romi', 'ROMI', 'percent'],
  ['roas', 'Поступления / ₽ рекламы', 'ratio'],
  ['firstResponseSeconds', 'Среднее время первого ответа', 'duration'],
] as const;
const units = {
  money: 'Рубли, ₽',
  count: 'Количество, шт.',
  percent: 'Доля / доходность, %',
  ratio: 'Поступления / расходы, ₽/₽',
  duration: 'Время первого ответа',
};
const palette = [
  '#abd958',
  '#e7b56e',
  '#72baf0',
  '#c8a0f4',
  '#69cab7',
  '#eb9bc2',
];
const defaultKeys = ['receipts', 'spend', 'impressions', 'contacts', 'romi', 'firstResponseSeconds'];
function preferences(): { enabled: string[]; group: 'day' | 'week' } {
  try {
    const value = JSON.parse(
      localStorage.getItem('vm-analytics-chart-v1') || 'null',
    );
    if (value && Array.isArray(value.enabled))
      return {
        enabled: value.enabled.filter((key: string) =>
          metrics.some((m) => m[0] === key),
        ),
        group: value.group === 'week' ? 'week' : 'day',
      };
  } catch {
    /* Storage may be unavailable in private mode. */
  }
  return { enabled: defaultKeys, group: 'day' };
}
export default function AnalyticsChart({
  daily,
}: {
  daily: LiveReport['daily'];
}) {
  const [settings, setSettings] = useState(preferences);
  const [selectedDate, setSelectedDate] = useState('');
  const data = analyticsSeries(daily, settings.group);
  const chosen = metrics.filter((m) => settings.enabled.includes(m[0]));
  const selected =
    data.find((d) => d.date === selectedDate) || data[data.length - 1];
  const label = (d: { date: string; end: string }) =>
    d.date === d.end
      ? d.date.split('-').reverse().join('.')
      : `${d.date.split('-').reverse().join('.')} – ${d.end.split('-').reverse().join('.')}`;
  function update(next: typeof settings) {
    setSettings(next);
    try {
      localStorage.setItem('vm-analytics-chart-v1', JSON.stringify(next));
    } catch {
      /* Presentation settings only. */
    }
  }
  const format = (v: number | null | undefined, unit: string) =>
    unit === 'duration' ? responseTime(v) : v == null
      ? '—'
      : v.toLocaleString('ru-RU', {
          maximumFractionDigits: unit === 'count' ? 0 : 2,
        }) + ({ money: ' ₽', percent: '%', ratio: ' ₽/₽' }[unit] || '');
  return (
    <section className="ac-chart">
      <div className="ac-section-head">
        <h2>Динамика показателей</h2>
        <label>
          Группировка{' '}
          <select
            aria-label="Группировка графика"
            value={settings.group}
            onChange={(e) =>
              update({
                ...settings,
                group: e.target.value === 'week' ? 'week' : 'day',
              })
            }
          >
            <option value="day">По дням</option>
            <option value="week">По неделям</option>
          </select>
        </label>
      </div>
      <div className="ac-metrics">
        {metrics.map(([key, name], i) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={settings.enabled.includes(key)}
              onChange={(e) =>
                update({
                  ...settings,
                  enabled: e.target.checked
                    ? [...settings.enabled, key]
                    : settings.enabled.filter((k) => k !== key),
                })
              }
            />
            <i style={{ background: palette[i % palette.length] }} />
            {name}
          </label>
        ))}
      </div>
      {!chosen.length && (
        <p className="ac-empty">Выберите хотя бы одну метрику.</p>
      )}
      {(Object.keys(units) as (keyof typeof units)[])
        .filter((unit) => chosen.some((m) => m[2] === unit))
        .map((unit) => (
          <section
            key={unit}
            className="ac-plot"
            aria-label={`${units[unit]}: ${chosen
              .filter((m) => m[2] === unit)
              .map((m) => m[1])
              .join(', ')}`}
          >
            <small>{units[unit]}</small>
            <ResponsiveContainer
              width="100%"
              height={unit === 'money' ? 165 : 130}
            >
              <LineChart
                data={data}
                margin={{ top: 8, right: 15, bottom: 0, left: 0 }}
              >
                <CartesianGrid vertical={false} stroke="var(--al-line)" />
                <XAxis
                  dataKey="date"
                  minTickGap={28}
                  tickFormatter={(v) =>
                    String(v).slice(5).split('-').reverse().join('.')
                  }
                  tick={{ fill: 'var(--al-muted)', fontSize: 11 }}
                />
                <YAxis
                  width={62}
                  tick={{ fill: 'var(--al-muted)', fontSize: 11 }}
                  tickFormatter={(v) =>
                    unit === 'duration' ? (Number(v) >= 3600
                      ? `${(Number(v) / 3600).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ч`
                      : Number(v) >= 60 ? `${(Number(v) / 60).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мин`
                      : `${Number(v)} с`) : Math.abs(Number(v)) >= 1000
                      ? `${(Number(v) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}к`
                      : String(v)
                  }
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--al-card)',
                    borderColor: 'var(--al-line)',
                    color: 'var(--al-text)',
                  }}
                  labelFormatter={(value) =>
                    label(
                      data.find((d) => d.date === value) || {
                        date: String(value),
                        end: String(value),
                      },
                    )
                  }
                  formatter={(v) =>
                    format(typeof v === 'number' ? v : null, unit)
                  }
                />
                {chosen
                  .filter((m) => m[2] === unit)
                  .map(([key, name]) => (
                    <Line
                      key={key}
                      dataKey={key}
                      name={name}
                      stroke={
                        palette[
                          metrics.findIndex((m) => m[0] === key) %
                            palette.length
                        ]
                      }
                      strokeDasharray={
                        metrics.findIndex((m) => m[0] === key) >= 6
                          ? '5 3'
                          : undefined
                      }
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </section>
        ))}
      {chosen.length > 0 && selected && (
        <>
          <div className="ac-section-head">
            <small>
              Отдельные шкалы для разных единиц · пропуски не заменяются нулём
            </small>
            <label>
              Дата{' '}
              <select
                aria-label="Дата точных значений"
                value={selected.date}
                onChange={(e) => setSelectedDate(e.target.value)}
              >
                {data.map((d) => (
                  <option key={d.date} value={d.date}>
                    {label(d)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="ac-chart-values" aria-live="polite">
            {chosen.map(([key, name, unit]) => (
              <span key={key}>
                {name}: <b>{format(selected[key], unit)}</b>
              </span>
            ))}
            {chosen.some(m => m[2] === 'duration') && <span>
              Диалогов с ответом: <b>{selected.responseAnswered ?? '—'}</b> · без ответа: <b>{selected.responseWaiting ?? '—'}</b>
            </span>}
          </div>
        </>
      )}
    </section>
  );
}
