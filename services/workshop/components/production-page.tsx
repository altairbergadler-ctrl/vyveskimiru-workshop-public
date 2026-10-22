'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Factory,
  RefreshCw,
  Search,
  UserRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

export type ProductionTask = {
  key: string;
  row: number;
  orderNumber: string;
  orderName: string;
  item: string;
  client: string;
  dueDate: string | null;
  stage: string;
  completed: boolean;
  availability: string;
  canComplete: boolean;
  assignee: string | null;
  plannedDate: string | null;
  completedDate: string | null;
  hours: number | null;
  normHours: number | null;
  payment: number | null;
  waitingFor: string[];
  comment: string | null;
  overdue: boolean;
};

export type ProductionData = {
  sheetName: string;
  today: string;
  allowOutOfOrder: boolean;
  stats: {
    total: number;
    completed: number;
    ready: number;
    waiting: number;
    overdue: number;
    planToday: number;
    completedToday: number;
    dueTodayOrders: number;
  };
  tasks: ProductionTask[];
  refreshedAt: string;
};

type ProductionFilter = 'active' | 'ready' | 'waiting' | 'today' | 'done';

type Props = {
  initialSearch?: string;
  data: ProductionData | null;
  error: string;
  loading: boolean;
  updatingRow: number | null;
  onBack: () => void;
  onRefresh: () => void;
  onToggle: (task: ProductionTask, completed: boolean) => void;
};

function readableDate(value: string | null) {
  if (!value) return 'не назначено';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
    .format(new Date(`${value}T12:00:00`))
    .replace('.', '');
}

function groupKey(task: ProductionTask) {
  return `${task.orderNumber}\u0000${task.item}`;
}

export default function ProductionPage({ initialSearch = '', data, error, loading, updatingRow, onBack, onRefresh, onToggle }: Props) {
  const [filter, setFilter] = useState<ProductionFilter>('active');
  const [search, setSearch] = useState(initialSearch);

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru-RU');
    return (data?.tasks ?? []).filter((task) => {
      if (filter === 'active' && task.completed) return false;
      if (filter === 'ready' && (task.completed || task.availability !== 'можно')) return false;
      if (filter === 'waiting' && (task.completed || task.availability !== 'ждёт')) return false;
      if (filter === 'today' && task.plannedDate !== data?.today && task.completedDate !== data?.today) return false;
      if (filter === 'done' && !task.completed) return false;
      if (!query) return true;
      return [task.orderNumber, task.orderName, task.item, task.client, task.stage, task.assignee, task.comment]
        .some((value) => value?.toLocaleLowerCase('ru-RU').includes(query));
    });
  }, [data, filter, search]);

  const groups = useMemo(() => {
    const visible = new Map<string, ProductionTask[]>();
    for (const task of filteredTasks) {
      const key = groupKey(task);
      visible.set(key, [...(visible.get(key) ?? []), task]);
    }
    return [...visible.entries()].map(([key, tasks]) => {
      const allTasks = data?.tasks.filter((task) => groupKey(task) === key) ?? tasks;
      return { key, tasks, allTasks, completed: allTasks.filter((task) => task.completed).length };
    });
  }, [data, filteredTasks]);

  const progress = data?.stats.planToday
    ? Math.min(100, Math.round((data.stats.completedToday / data.stats.planToday) * 100))
    : 0;

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-7 lg:px-10 lg:py-9">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Button variant="ghost" size="sm" className="-ml-3 mb-2 text-muted-foreground" onClick={onBack}><ChevronLeft />На главную</Button>
          <p className="text-sm text-muted-foreground">Задачи из Google Таблицы</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Производство</h1>
        </div>
        <Button variant="outline" className="h-10" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} />Обновить</Button>
      </div>

      {error && (
        <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-[#ef755e]/25 bg-[#fff0ec] p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span><Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw />Повторить</Button>
        </div>
      )}

      <section className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Показатели производства">
        <article className="rounded-[20px] bg-[#171b18] p-5 text-white">
          <div className="flex items-center justify-between"><p className="text-sm text-white/55">План на сегодня</p><CalendarCheck2 className="size-5 text-[#b5f23c]" /></div>
          <p className="mt-4 text-3xl font-semibold">{loading ? '—' : data?.stats.planToday ?? '—'}</p>
          <p className="mt-2 text-xs text-white/45">по колонке «План»</p>
        </article>
        <article className="rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">Выполнено сегодня</p><CheckCircle2 className="size-5 text-[#6d942c]" /></div>
          <p className="mt-4 text-3xl font-semibold">{loading ? '—' : data?.stats.completedToday ?? '—'}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-[#9bd226] transition-all" style={{ width: `${progress}%` }} /></div>
        </article>
        <article className="rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">Можно делать</p><Factory className="size-5 text-[#6d942c]" /></div>
          <p className="mt-4 text-3xl font-semibold">{loading ? '—' : data?.stats.ready ?? '—'}</p>
          <p className="mt-2 text-xs text-muted-foreground">этапов доступны сейчас</p>
        </article>
        <article className="rounded-[20px] border border-[#ef755e]/20 bg-[#fff7f4] p-5">
          <div className="flex items-center justify-between"><p className="text-sm text-[#955242]">Просрочено</p><AlertTriangle className="size-5 text-[#cf624d]" /></div>
          <p className="mt-4 text-3xl font-semibold text-[#743c31]">{loading ? '—' : data?.stats.overdue ?? '—'}</p>
          <p className="mt-2 text-xs text-[#a56557]">незавершённых этапов</p>
        </article>
      </section>

      {data?.allowOutOfOrder && <div className="mt-4 rounded-xl border border-[#f0ba65]/35 bg-[#fff8e8] px-4 py-3 text-sm text-[#805a20]">В таблице включено выполнение этапов не по порядку.</div>}

      <section className="mt-5 rounded-[22px] border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative min-w-0 flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Заказ, изделие, этап или исполнитель…" className="h-10 pl-9" aria-label="Поиск производственных задач" />
          </div>
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl bg-muted p-1 text-xs">
            {([
              ['active', 'Активные'],
              ['ready', 'Можно'],
              ['waiting', 'Ждут'],
              ['today', 'Сегодня'],
              ['done', 'Готово'],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" onClick={() => setFilter(value)} className={`shrink-0 rounded-lg px-3 py-2 transition ${filter === value ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground'}`}>{label}</button>
            ))}
          </div>
        </div>
      </section>

      {!loading && groups.length === 0 ? (
        <div className="mt-4 rounded-[22px] border border-dashed border-border bg-card py-16 text-center">
          <CheckCircle2 className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">По выбранным условиям задач нет</p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {groups.map((group) => {
            const head = group.tasks[0];
            const percent = group.allTasks.length ? Math.round((group.completed / group.allTasks.length) * 100) : 0;
            return (
              <article key={group.key} className="overflow-hidden rounded-[22px] border border-border bg-card">
                <header className="border-b border-border/70 bg-muted/35 px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="rounded-md bg-[#171b18] px-2 py-1 text-xs font-semibold text-white">№ {head.orderNumber}</span><h2 className="font-semibold">{head.orderName || `Заказ №${head.orderNumber}`}</h2></div>
                      <p className="mt-2 text-sm text-muted-foreground">{head.item}{head.client ? ` · ${head.client}` : ''}</p>
                    </div>
                    <div className="shrink-0 text-sm sm:text-right"><p className={head.dueDate && head.dueDate < (data?.today ?? '') && group.completed < group.allTasks.length ? 'font-medium text-[#c35642]' : 'text-muted-foreground'}>Сдать {readableDate(head.dueDate)}</p><p className="mt-1 text-xs text-muted-foreground">{group.completed} из {group.allTasks.length} этапов</p></div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border/70"><div className="h-full rounded-full bg-[#9bd226] transition-all" style={{ width: `${percent}%` }} /></div>
                </header>
                <div className="divide-y divide-border/65">
                  {group.tasks.map((task) => {
                    const updating = updatingRow === task.row;
                    const blocked = !task.completed && !task.canComplete;
                    return (
                      <div key={task.key} className={`flex items-start gap-3 px-4 py-4 sm:px-5 ${task.completed ? 'bg-[#f7fbea]' : task.overdue ? 'bg-[#fff8f5]' : ''}`}>
                        <Checkbox
                          checked={task.completed}
                          disabled={updating || blocked}
                          onCheckedChange={(checked) => onToggle(task, Boolean(checked))}
                          aria-label={`${task.completed ? 'Снять выполнение' : 'Выполнить'}: ${task.stage}`}
                          className="mt-0.5 size-6 rounded-md"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className={`font-medium ${task.completed ? 'text-muted-foreground line-through' : ''}`}>{task.stage}</p>
                            {updating && <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />}
                            {!task.completed && task.plannedDate === data?.today && <span className="rounded-full bg-[#e9f1ff] px-2 py-0.5 text-[11px] font-medium text-[#3766a3]">План сегодня</span>}
                            {task.completed && <span className="rounded-full bg-[#edf8d9] px-2 py-0.5 text-[11px] font-medium text-[#5c7f24]">Готово{task.completedDate ? ` · ${readableDate(task.completedDate)}` : ''}</span>}
                            {!task.completed && task.availability === 'можно' && <span className="rounded-full bg-[#edf8d9] px-2 py-0.5 text-[11px] font-medium text-[#5c7f24]">Можно делать</span>}
                            {blocked && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Ждёт очередь</span>}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            {task.assignee && <span className="inline-flex items-center gap-1"><UserRound className="size-3.5" />{task.assignee}</span>}
                            {task.normHours !== null && <span className="inline-flex items-center gap-1"><Clock3 className="size-3.5" />Норма {task.normHours} ч</span>}
                            {task.waitingFor.length > 0 && blocked && <span>Сначала: {task.waitingFor.join(', ')}</span>}
                            {task.comment && <span>{task.comment}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
