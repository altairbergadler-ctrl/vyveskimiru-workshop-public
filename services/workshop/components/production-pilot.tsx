import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  Image as ImageIcon,
  Package,
  Play,
  RefreshCw,
  X,
  Factory,
  LayoutDashboard,
  BarChart3,
  Boxes,
  Columns3,
  LayoutGrid,
} from 'lucide-react';
import { Button } from './ui/button';
import { ToolsMenu, ToolsSubmenu } from './tools-navigation';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from './ui/dropdown-menu';
import './production-pilot.css';

type Stage = {
  id: string;
  name: string;
  kind: 'manual' | 'machine' | 'wait';
  minutes: number;
  skill: string;
  resourceId: string;
  dependencies: string[];
  materials: { sku: string; quantity: number }[];
  setupMinutes: number;
  finishMinutes: number;
  controlEvery: number;
  controlMinutes: number;
};
type Worker = {
  id: string;
  name: string;
  skills: string[];
  zones: string[];
  enabled: boolean;
  access: boolean;
  hasPin?: boolean;
  role: 'master' | 'lead';
  shiftStart: string;
  shiftEnd: string;
  days: number[];
};
type Plan = {
  taskId: string;
  workerId: string | null;
  start: string;
  end: string;
  reason: string;
  late: boolean;
  phases: { start: string; end: string }[];
};
type Task = Stage & {
  startBlockedReason?: string;
  needsSetup?: boolean;
  orderId: string;
  itemId: string;
  quantity: number;
  doneQuantity: number;
  unit: string;
  status: string;
  workerId: string | null;
  assignedWorkerId: string | null;
  mustDate: string;
  dueAt: string;
  startedAt?: string;
  expectedEnd?: string;
  expectedLate: boolean;
  blockedReason?: string;
  ready: boolean;
  schedulingProblem: string;
  schedule: Plan | null;
  pin: { workerId: string; rank: number; start?: string } | null;
  materialList: {
    sku: string;
    name: string;
    need: number;
    issued: number;
    remaining: number;
    available: number;
    unit: string;
    location: string;
  }[];
};
type Product = {
  needsSetup?: boolean;
  id: string;
  name: string;
  unit: string;
  versions: { version: number; stages: Stage[] }[];
};
type Order = {
  id: string;
  name: string;
  customer: string;
  dueAt: string;
  status: string;
  media: { id: string; name: string; url: string }[];
};
type RecordEntry = {
  id: string;
  workerId: string | null;
  recordedBy: string;
  taskId: string;
  itemId: string;
  orderId: string;
  stage: string;
  quantity: number;
  unit: string;
  completedAt: string;
  startedAt: string;
  partial: boolean;
};
type Data = {
  pilot: boolean;
  storagePending?: boolean;
  revision: number;
  actor: { id: string; name: string; role: string };
  now: string;
  today: string;
  timeZone: string;
  workers: Worker[];
  tasks: Task[];
  resources: { id: string; name: string; zone: string }[];
  products: Product[];
  orders: Order[];
  items: {
    id: string;
    name: string;
    orderId: string;
    quantity: number;
    unit: string;
    productVersion: number;
  }[];
  warehouse: {
    sku: string;
    name: string;
    stock: number;
    reserved: number;
    unit: string;
    location: string;
  }[];
  records: RecordEntry[];
  pendingOrders: string[];
  boardError: string;
  plan: { planned: Plan[] };
};
type Command = {
  requestId: string;
  revision: number;
  type: string;
  data: unknown;
};
const defaultStage = (): Stage => ({
  id: crypto.randomUUID(),
  name: 'Новый этап',
  kind: 'manual',
  minutes: 20,
  skill: 'Сборка',
  resourceId: 'bench',
  dependencies: [],
  materials: [],
  setupMinutes: 5,
  finishMinutes: 5,
  controlEvery: 0,
  controlMinutes: 0,
});
const blankWorker = (): Worker => ({
  id: '',
  name: '',
  skills: [],
  zones: [],
  enabled: true,
  access: false,
  role: 'master',
  shiftStart: '09:00',
  shiftEnd: '18:00',
  days: [1, 2, 3, 4, 5],
});

function PilotDialog({
  title,
  children,
  close,
  busy,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  busy: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="pp-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="pp-between">
        <h2>{title}</h2>
        <button onClick={close} disabled={busy} aria-label="Закрыть">
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export default function ProductionPilot() {
  const [data, setData] = useState<Data | null>(null),
    [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(() =>
      new URLSearchParams(window.location.search).has('search')
        ? 'plan'
        : 'day',
    ),
    [selectedWorker, setSelectedWorker] = useState('boris'),
    [selectedTask, setSelectedTask] = useState(''),
    [detail, setDetail] = useState(''),
    [gallery, setGallery] = useState<{ order: Order; index: number } | null>(
      null,
    );
  const [login, setLogin] = useState(''),
    [pin, setPin] = useState('');
  const [planSearch, setPlanSearch] = useState(
    () => new URLSearchParams(window.location.search).get('search') || '',
  );
  const [historyWorker, setHistoryWorker] = useState('all'),
    [historyFrom, setHistoryFrom] = useState('');
  const [taskForm, setTaskForm] = useState<{ task: Task; kind: string } | null>(
      null,
    ),
    [formQty, setFormQty] = useState('1'),
    [formReason, setFormReason] = useState(''),
    [formMinutes, setFormMinutes] = useState('20'),
    [formWorker, setFormWorker] = useState(''),
    [formRank, setFormRank] = useState('1'),
    [formStart, setFormStart] = useState('');
  const [formMustDate, setFormMustDate] = useState('');
  const [editProduct, setEditProduct] = useState<{
      taskId?: string;
      id: string;
      name: string;
      unit: string;
      stages: Stage[];
    } | null>(null),
    [editWorker, setEditWorker] = useState<Worker | null>(null),
    [newPin, setNewPin] = useState('');
  const [addItem, setAddItem] = useState(false),
    [itemOrder, setItemOrder] = useState('9001'),
    [itemProduct, setItemProduct] = useState('letters'),
    [itemQty, setItemQty] = useState('1');
  const [refill, setRefill] = useState(''),
    [refillQty, setRefillQty] = useState('1');
  const [pending, setPending] = useState<Command | null>(null);
  const inFlight = useRef(false);
  const manager = data?.actor.role !== 'master';
  const time = (iso?: string | null) =>
    iso
      ? new Intl.DateTimeFormat('ru-RU', {
          timeZone: data?.timeZone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(iso))
      : 'не назначено';
  const pendingRef = useRef<Command | null>(null);
  const loadingRef = useRef(false);
  const rememberPending = useCallback((value: Command | null) => {
    pendingRef.current = value;
    setPending(value);
  }, []);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const requestId = pendingRef.current?.requestId;
      const response = await fetch(
        '/api/production-pilot' +
          (requestId ? '?requestId=' + encodeURIComponent(requestId) : ''),
        {
          cache: 'no-store',
          credentials: 'same-origin',
        },
      );
      const value = await response.json();
      if (response.status === 401) {
        if (value.loginUrl === '/?action=production') {
          window.location.replace('/?action=production');
          return;
        }
        setAuthenticated(false);
        setData(null);
        return;
      }
      if (!response.ok) throw new Error(value.error);
      setData((current) =>
        current && current.revision > value.revision ? current : value,
      );
      if (
        requestId &&
        value.confirmedRequestId === requestId &&
        pendingRef.current?.requestId === requestId
      )
        rememberPending(null);
      if (!pendingRef.current) setError('');
      setAuthenticated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Производство недоступно.');
    } finally {
      loadingRef.current = false;
    }
  }, [rememberPending]);
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      if (!inFlight.current) void load();
    }, 10000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (
      !gallery &&
      !taskForm &&
      !editProduct &&
      !editWorker &&
      !addItem &&
      !refill
    )
      return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !inFlight.current) {
        setGallery(null);
        setTaskForm(null);
        setEditProduct(null);
        setEditWorker(null);
        setAddItem(false);
        setRefill('');
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [gallery, taskForm, editProduct, editWorker, addItem, refill]);
  async function command(type: string, payload: unknown, retry?: Command) {
    if (!data || inFlight.current || (pending && !retry)) return false;
    const request = retry || {
      requestId: crypto.randomUUID(),
      revision: data.revision,
      type,
      data: payload,
    };
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/production-pilot/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const result = await r.json();
      if (!r.ok) {
        if (r.status >= 500) rememberPending(request);
        else {
          rememberPending(null);
          if (result.code === 'stale') await load();
        }
        throw new Error(result.error);
      }
      rememberPending(null);
      setData(result);
      return true;
    } catch (e) {
      if (e instanceof TypeError) rememberPending(request);
      setError(e instanceof Error ? e.message : 'Не удалось сохранить.');
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const disabled = busy || Boolean(pending) || Boolean(data?.storagePending);
  const orderFor = (t: Task) => data?.orders.find((o) => o.id === t.orderId);
  const workerName = (id: string | null) =>
    data?.workers.find((w) => w.id === id)?.name ||
    (id ? 'Мастер' : 'Не назначен');
  const displayWorker = data?.workers.some((w) => w.id === selectedWorker)
    ? selectedWorker
    : data?.workers[0]?.id || '';
  const dueTasks =
    data?.tasks
      .filter(
        (t) =>
          t.status !== 'done' &&
          (manager ? t.assignedWorkerId === displayWorker : true),
      )
      .sort(
        (a, b) =>
          (a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0) ||
          (a.pin?.rank || 9999) - (b.pin?.rank || 9999) ||
          (a.schedule?.start || 'z').localeCompare(b.schedule?.start || 'z'),
      ) || [];
  const current =
    dueTasks.find((t) => t.id === selectedTask) ||
    dueTasks.find(
      (t) => ['running', 'paused'].includes(t.status) && t.kind !== 'wait',
    ) ||
    dueTasks.find((t) => t.ready && !t.schedulingProblem) ||
    dueTasks[0];
  const records =
    data?.records
      .filter(
        (r) =>
          (manager
            ? historyWorker === 'all' || r.workerId === historyWorker
            : true) &&
          (!historyFrom ||
            new Intl.DateTimeFormat('en-CA', {
              timeZone: data.timeZone,
            }).format(new Date(r.completedAt)) >= historyFrom),
      )
      .slice()
      .reverse() || [];
  function openTaskForm(t: Task, kind: string) {
    setTaskForm({ task: t, kind });
    setFormQty(String(t.quantity - t.doneQuantity));
    setFormMinutes(String(t.minutes));
    setFormReason('');
    setFormWorker(t.assignedWorkerId || '');
    setFormRank(String(t.pin?.rank ?? 1));
    const pinnedDate = t.pin?.start ? new Date(t.pin.start) : null;
    setFormStart(
      pinnedDate
        ? new Date(+pinnedDate - pinnedDate.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : '',
    );
    setFormMustDate(t.mustDate);
  }
  function editStage(index: number, patch: Partial<Stage>) {
    setEditProduct(
      (p) =>
        p && {
          ...p,
          stages: p.stages.map((s, i) =>
            i === index ? { ...s, ...patch } : s,
          ),
        },
    );
  }
  async function saveTaskForm() {
    if (!taskForm) return;
    const { task: t, kind } = taskForm;
    const payload =
      kind === 'assign'
        ? {
            taskId: t.id,
            workerId: formWorker,
            rank: Number(formRank),
            minutes: Number(formMinutes),
            start: formStart ? new Date(formStart).toISOString() : null,
            clearBlock: true,
            mustDate: formMustDate,
          }
        : kind === 'complete'
          ? { taskId: t.id, quantity: Number(formQty) }
          : kind === 'delay'
            ? { taskId: t.id, minutes: Number(formMinutes) }
            : { taskId: t.id, reason: formReason };
    if (await command(`task.${kind}`, payload)) setTaskForm(null);
  }
  const modal = (
    title: string,
    children: React.ReactNode,
    close: () => void,
  ) => (
    <PilotDialog title={title} close={close} busy={busy}>
      {children}
      {error && (
        <p className="pp-error" role="alert">
          {error}
        </p>
      )}
    </PilotDialog>
  );
  if (authenticated === false)
    return (
      <main className="pp-login">
        <div className="pp-card">
          <h1>Мастерская</h1>
          <p>Вход в производство</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                const r = await fetch('/api/production-pilot/session', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ login, pin }),
                });
                const v = await r.json();
                if (!r.ok) throw new Error(v.error);
                setPin('');
                await load();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Ошибка входа');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Логин мастера
              <input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              Код доступа
              <input
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoComplete="current-password"
                inputMode="numeric"
              />
            </label>
            <button className="pp-primary" disabled={busy}>
              Войти
            </button>
          </form>
          {error && (
            <p className="pp-error" role="alert">
              {error}
            </p>
          )}
          <p className="pp-muted">
            Личный доступ включает руководитель в карточке мастера.
          </p>
          <a href="/?action=production">Вход руководителя</a>
        </div>
      </main>
    );
  if (!data)
    return (
      <main className="pp-login">
        <h2>Загружаю производство…</h2>
        {error && <p className="pp-error">{error}</p>}
        <button onClick={() => void load()}>Повторить</button>
      </main>
    );
  return (
    <div className={`pp-app ${manager ? 'pp-manager' : ''}`}>
      {manager && (
        <aside className="pp-sidebar">
          <a className="pp-brand" href="/">
            <span>
              <Factory size={20} />
            </span>
            <div>
              <strong>Мастерская</strong>
              <small>Наружная реклама</small>
            </div>
          </a>
          <nav aria-label="Основная навигация">
            {data.actor.role === 'owner' && (
              <a href="/">
                <LayoutDashboard size={18} />
                Дашборд
              </a>
            )}
            <a href="/production/" aria-current="page">
              <Factory size={18} />
              Производство
            </a>
            {data.actor.role === 'owner' && (
              <>
                <a href="/#analytics">
                  <BarChart3 size={18} />
                  Аналитика
                </a>
                <a href="/#warehouse">
                  <Boxes size={18} />
                  Склад
                </a>
                <a href="/kanban/">
                  <Columns3 size={18} />
                  Заказы
                </a>
                <ToolsMenu className="pp-tools-trigger" />
              </>
            )}
          </nav>
          <div className="pp-sidebar-foot">
            {data.pilot ? 'Тестовое производство' : 'Производство мастерской'}
            <small>{data.actor.name}</small>
          </div>
        </aside>
      )}
      <header className="pp-header">
        <div className="pp-brand">
          <span>
            <Factory size={20} />
          </span>
          <div>
            <strong>Производство</strong>
            <small>Наружная реклама</small>
          </div>
        </div>
        <div className="pp-actions">
          {manager && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Меню и ссылки"
                  />
                }
              >
                <LayoutGrid size={18} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-60 max-w-[calc(100vw-2rem)]"
                style={{ fontFamily: "'Segoe UI', Arial, sans-serif" }}
              >
                <DropdownMenuGroup>
                  {data.actor.role === 'owner' && (
                    <DropdownMenuItem
                      render={<a href="/" aria-label="Дашборд" />}
                    >
                      <LayoutDashboard />
                      Дашборд
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    render={<a href="/production/" aria-label="Производство" />}
                  >
                    <Factory />
                    Производство
                  </DropdownMenuItem>
                  {data.actor.role === 'owner' && (
                    <>
                      <DropdownMenuItem render={<a href="/#analytics" aria-label="Аналитика" />}>
                        <BarChart3 />
                        Аналитика
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        render={<a href="/#warehouse" aria-label="Склад" />}
                      >
                        <Boxes />
                        Склад
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        render={<a href="/kanban/" aria-label="Заказы" />}
                      >
                        <Columns3 />
                        Заказы
                      </DropdownMenuItem>
                      <ToolsSubmenu />
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span>{data.actor.name}</span>
          <button
            onClick={() => void load()}
            disabled={busy}
            aria-label="Обновить"
          >
            <RefreshCw size={16} />
          </button>
          {!manager && (
            <button
              onClick={async () => {
                await fetch('/api/production-pilot/session', {
                  method: 'DELETE',
                });
                await load();
              }}
            >
              Выйти
            </button>
          )}
        </div>
      </header>
      <main className="pp-main">
        {data.pilot && (
          <p className="pp-pilot">
            Тестовое производство · вымышленные заказы и остатки · изменения
            сохраняются на этом компьютере
          </p>
        )}
        {manager && (
          <nav className="pp-nav" aria-label="Производство">
            {[
              ['day', 'Экран мастера'],
              ['plan', 'План'],
              ['products', 'Продукты'],
              ['workers', 'Мастера'],
              ['warehouse', 'Материалы'],
              ['orders', 'Заказы'],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={tab === id}
                onClick={() => {
                  setTab(id);
                  setError('');
                }}
              >
                {label}
              </button>
            ))}
            <a href="/kanban/" target="_blank" rel="noreferrer">
              Доска заказов ↗
            </a>
          </nav>
        )}
        {error && (
          <div className="pp-error" role="alert">
            {error}
          </div>
        )}
        {pending && (
          <div className="pp-warning">
            Ответ не подтверждён. Проверьте сохранение этой же команды.
            <button
              disabled={busy}
              onClick={() => void command(pending.type, pending.data, pending)}
            >
              Проверить действие
            </button>
          </div>
        )}
        {data.storagePending && (
          <p className="pp-warning">
            Проверяется запись в Google Таблице. Новые действия временно
            остановлены, повторное списание не отправляется.
          </p>
        )}
        {manager && !data.workers.length && (
          <p className="pp-warning">
            Этапы перенесены. Добавьте мастеров и их компетенции в разделе
            «Мастера», чтобы построить план. Материалы и оборудование каждого
            этапа можно настроить в плане.
          </p>
        )}
        {data.pendingOrders.length > 0 && (
          <p className="pp-warning">
            {data.boardError ||
              'Подтверждаем переход завершённого заказа на доске…'}
          </p>
        )}
        {tab === 'day' && (
          <>
            <div className="pp-heading">
              <div>
                <h1>Моя работа</h1>
                <p className="pp-muted">
                  {data.today} · обязательные задачи и текущая работа
                </p>
              </div>
              <div className="pp-actions">
                {manager && (
                  <label className="pp-inline">
                    Мастер
                    <select
                      value={displayWorker}
                      onChange={(e) => {
                        setSelectedWorker(e.target.value);
                        setSelectedTask('');
                        setDetail('');
                      }}
                    >
                      {data.workers.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  onClick={() => {
                    setHistoryWorker(manager ? displayWorker : data.actor.id);
                    setTab('history');
                  }}
                >
                  Выполненные работы →
                </button>
              </div>
            </div>
            {dueTasks.some(
              (t) => t.status === 'running' && t.id !== current?.id,
            ) && (
              <div className="pp-actions pp-warning">
                Уже в работе:
                {dueTasks
                  .filter((t) => t.status === 'running' && t.id !== current?.id)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        setSelectedTask(t.id);
                        setDetail('');
                      }}
                    >
                      {t.name} · до {time(t.expectedEnd)}
                    </button>
                  ))}
              </div>
            )}
            <div className="pp-day-grid">
              <section className="pp-card pp-current">
                {current ? (
                  <>
                    <div className="pp-between">
                      <span className="pp-tag pp-green">
                        {
                          (
                            {
                              todo: 'Сейчас',
                              running: 'В работе',
                              paused: 'Приостановлено',
                            } as Record<string, string>
                          )[current.status]
                        }
                      </span>
                      <span className="pp-muted">
                        Нужно до {time(current.dueAt)}
                      </span>
                    </div>
                    <h2 className="pp-task-title">{current.name}</h2>
                    <p className="pp-muted">
                      Осталось{' '}
                      {Math.round(
                        (current.quantity - current.doneQuantity) * 1000,
                      ) / 1000}{' '}
                      {current.unit} · план {current.minutes} мин
                    </p>
                    <div className="pp-order-line">
                      {orderFor(current)?.media[0] && (
                        <button
                          className="pp-thumb"
                          onClick={() =>
                            setGallery({ order: orderFor(current)!, index: 0 })
                          }
                        >
                          <img
                            src={orderFor(current)!.media[0].url}
                            alt="Макет заказа"
                          />
                        </button>
                      )}
                      <div>
                        <strong>
                          № {current.orderId} · {orderFor(current)?.name}
                        </strong>
                        <p className="pp-muted">
                          {
                            data.items.find((i) => i.id === current.itemId)
                              ?.name
                          }
                        </p>
                      </div>
                    </div>
                    <p
                      className={
                        current.expectedLate ? 'pp-warning' : 'pp-muted'
                      }
                    >
                      {current.status === 'running'
                        ? `${current.expectedLate ? 'Есть задержка. Последний прогноз' : 'Ожидаемое завершение'}: ${time(current.expectedEnd)}`
                        : current.schedule
                          ? `По плану: ${time(current.schedule.start)} → ${time(current.schedule.end)}`
                          : 'Время пока не назначено'}
                    </p>
                    {(!current.ready ||
                      current.schedulingProblem ||
                      current.blockedReason) && (
                      <p className="pp-warning">
                        {current.blockedReason ||
                          current.schedulingProblem ||
                          'Сначала должны завершиться все предыдущие этапы.'}
                      </p>
                    )}
                    <div className="pp-actions">
                      <button
                        onClick={() =>
                          setDetail(detail === 'materials' ? '' : 'materials')
                        }
                      >
                        <Package size={15} /> Материалы ·{' '}
                        {current.materialList.length}
                      </button>
                      <button
                        onClick={() =>
                          setGallery({ order: orderFor(current)!, index: 0 })
                        }
                      >
                        <ImageIcon size={15} /> Изображения ·{' '}
                        {orderFor(current)?.media.length || 0}
                      </button>
                    </div>
                    {detail === 'materials' && (
                      <div className="pp-details">
                        <h3>Взять для этапа</h3>
                        {current.materialList.length ? (
                          current.materialList.map((m) => (
                            <div className="pp-row" key={m.sku}>
                              <div>
                                <strong>{m.name}</strong>
                                <p className="pp-muted">{m.location}</p>
                                <p className="pp-muted">
                                  Нужно {m.need} · уже получено {m.issued} ·
                                  свободно {m.available} {m.unit}
                                </p>
                              </div>
                              <strong>
                                {m.remaining} {m.unit}
                              </strong>
                            </div>
                          ))
                        ) : (
                          <p className="pp-muted">
                            Для этого этапа материалы не заданы.
                          </p>
                        )}
                        {current.materialList.some((m) => m.remaining > 0) && (
                          <button
                            disabled={
                              disabled ||
                              current.materialList.some(
                                (m) => m.remaining > m.available,
                              )
                            }
                            onClick={() =>
                              void command('task.issue', { taskId: current.id })
                            }
                          >
                            Подтвердить получение со склада
                          </button>
                        )}
                        <p className="pp-muted">
                          {data.pilot
                            ? 'Подтверждение уменьшит только тестовый остаток.'
                            : 'Получение будет записано в движениях склада этого заказа.'}
                          Просмотр ничего не списывает.
                        </p>
                      </div>
                    )}
                    {['todo', 'paused'].includes(current.status) &&
                      current.startBlockedReason && (
                        <output className="pp-muted">
                          {current.startBlockedReason}
                        </output>
                      )}
                    <div className="pp-actions pp-space">
                      <button
                        className="pp-primary"
                        disabled={
                          disabled ||
                          (['todo', 'paused'].includes(current.status) &&
                            Boolean(current.startBlockedReason))
                        }
                        onClick={() =>
                          void command(
                            current.status === 'todo'
                              ? 'task.start'
                              : current.status === 'paused'
                                ? 'task.resume'
                                : 'task.complete',
                            { taskId: current.id },
                          )
                        }
                      >
                        {current.status === 'todo' ? (
                          <>
                            <Play size={16} />
                            Начать
                          </>
                        ) : current.status === 'paused' ? (
                          'Продолжить'
                        ) : (
                          <>
                            <Check size={16} />
                            Готово
                          </>
                        )}
                      </button>
                      <button
                        disabled={disabled || current.status === 'paused'}
                        onClick={() =>
                          openTaskForm(
                            current,
                            current.status === 'running' ? 'pause' : 'block',
                          )
                        }
                      >
                        {current.status === 'running'
                          ? 'Пауза / проблема'
                          : 'Есть препятствие'}
                      </button>
                      {current.status === 'running' && (
                        <>
                          <button
                            disabled={disabled}
                            onClick={() => openTaskForm(current, 'complete')}
                          >
                            Часть работы
                          </button>
                          <button
                            disabled={disabled}
                            onClick={() => openTaskForm(current, 'delay')}
                          >
                            Сколько осталось
                          </button>
                        </>
                      )}
                      {manager && (
                        <button
                          disabled={disabled || current.status === 'running'}
                          onClick={() => openTaskForm(current, 'assign')}
                        >
                          Назначение
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="pp-tag pp-green">Доступных задач нет</span>
                    <h2 className="pp-space">Очередь пуста</h2>
                    <p className="pp-muted">
                      Руководитель может добавить изделие в заказ или проверить
                      назначения.
                    </p>
                  </>
                )}
              </section>
              <aside className="pp-card">
                <div className="pp-between">
                  <h3>Обязательно сегодня</h3>
                  <span className="pp-muted">
                    {dueTasks.filter((t) => t.mustDate <= data.today).length}
                  </span>
                </div>
                {dueTasks
                  .filter((t) => t.mustDate <= data.today)
                  .map((t, i) => (
                    <div className="pp-row" key={t.id}>
                      <span className="pp-number">{i + 1}</span>
                      <div>
                        <button
                          onClick={() => {
                            setSelectedTask(t.id);
                            setDetail('');
                          }}
                          aria-pressed={t.id === current?.id}
                        >
                          {t.name}
                        </button>
                        <p className="pp-muted">
                          № {t.orderId} · {orderFor(t)?.name}
                        </p>
                        <div className="pp-between">
                          <span
                            className={`pp-tag ${t.schedulingProblem || t.blockedReason ? 'pp-amber' : ''}`}
                          >
                            {t.status === 'running'
                              ? 'В работе'
                              : t.status === 'paused'
                                ? 'Приостановлено'
                                : t.id === current?.id
                                  ? 'Сейчас'
                                  : t.ready
                                    ? 'Далее'
                                    : 'Ждёт предыдущие этапы'}
                          </span>
                          <span className="pp-muted">До {time(t.dueAt)}</span>
                        </div>
                        {(t.schedulingProblem || t.blockedReason) && (
                          <p className="pp-muted">
                            {t.blockedReason || t.schedulingProblem}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
              </aside>
            </div>
          </>
        )}
        {tab === 'history' && (
          <>
            <div className="pp-heading">
              <div>
                <button onClick={() => setTab('day')}>
                  <ChevronLeft size={16} />К задачам
                </button>
                <h1>Выполненные работы</h1>
              </div>
              <div className="pp-actions">
                {manager && (
                  <label>
                    Мастер
                    <select
                      value={historyWorker}
                      onChange={(e) => setHistoryWorker(e.target.value)}
                    >
                      <option value="all">Все</option>
                      {data.workers.map((w) => (
                        <option value={w.id} key={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Начиная с
                  <input
                    type="date"
                    value={historyFrom}
                    onChange={(e) => setHistoryFrom(e.target.value)}
                  />
                </label>
              </div>
            </div>
            <div className="pp-card">
              {!records.length && (
                <p>В выбранном периоде выполненных работ нет.</p>
              )}
              {records.map((r) => (
                <div className="pp-row" key={r.id}>
                  <span className="pp-number">✓</span>
                  <div>
                    <strong>{r.stage}</strong>
                    <p>
                      № {r.orderId} · {r.quantity} {r.unit}
                      {r.partial ? ' · частичное выполнение' : ''}
                    </p>
                    <p className="pp-muted">
                      {workerName(r.workerId)} · завершено {time(r.completedAt)}{' '}
                      · начато {time(r.startedAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {manager && tab === 'plan' && (
          <>
            <div className="pp-heading">
              <div>
                <h1>План производства</h1>
                <p className="pp-muted">
                  Сроки → зависимости → свободные мастера и оборудование
                </p>
              </div>
              <label>
                Поиск по плану
                <input
                  value={planSearch}
                  onChange={(e) => setPlanSearch(e.target.value)}
                  placeholder="Заказ, этап или мастер"
                />
              </label>
              <button disabled={disabled} onClick={() => void load()}>
                Пересчитать
              </button>
            </div>
            <div className="pp-card pp-plan">
              {data.tasks
                .filter((t) => t.status !== 'done')
                .filter(
                  (t) =>
                    !planSearch ||
                    [
                      t.name,
                      t.orderId,
                      orderFor(t)?.name,
                      workerName(t.assignedWorkerId),
                      data.items.find((i) => i.id === t.itemId)?.name,
                    ]
                      .join(' ')
                      .toLocaleLowerCase('ru-RU')
                      .includes(planSearch.toLocaleLowerCase('ru-RU')),
                )
                .sort((a, b) =>
                  (a.startedAt || a.schedule?.start || 'z').localeCompare(
                    b.startedAt || b.schedule?.start || 'z',
                  ),
                )
                .map((t, index) => (
                  <div className="pp-plan-row" key={t.id}>
                    <div>
                      <strong>
                        {index + 1}. {t.name}
                      </strong>
                      <p className="pp-muted">
                        № {t.orderId} ·{' '}
                        {data.items.find((i) => i.id === t.itemId)?.name}
                      </p>
                      <p className="pp-muted">
                        {t.dependencies.length
                          ? `После: ${t.dependencies.map((id) => data.tasks.find((prior) => prior.id === id)?.name || id).join(', ')}`
                          : 'Можно начать независимо'}
                        {t.pin ? ' · Закреплено руководителем' : ''}
                      </p>
                    </div>
                    <div>
                      {t.kind === 'wait'
                        ? 'Технологическое ожидание'
                        : workerName(t.assignedWorkerId)}
                      <p className="pp-muted">
                        {data.resources.find((r) => r.id === t.resourceId)
                          ?.name || 'Без оборудования'}
                      </p>
                    </div>
                    <div>
                      <span
                        className={
                          t.schedule?.late || t.expectedLate
                            ? 'pp-tag pp-amber'
                            : ''
                        }
                      >
                        {time(
                          t.status === 'running'
                            ? t.startedAt
                            : t.schedule?.start,
                        )}{' '}
                        →{' '}
                        {time(
                          t.status === 'running'
                            ? t.expectedEnd
                            : t.schedule?.end,
                        )}
                      </span>
                      <p className="pp-muted">
                        {t.blockedReason ||
                          t.schedulingProblem ||
                          t.schedule?.reason}
                      </p>
                      {t.kind === 'machine' && t.schedule && (
                        <details>
                          <summary>Обслуживание оборудования</summary>
                          {t.schedule.phases.map((p) => (
                            <p className="pp-muted" key={p.start}>
                              {time(p.start)} — {time(p.end)}
                            </p>
                          ))}
                        </details>
                      )}
                    </div>
                    <div className="pp-actions">
                      {t.status === 'todo' && (
                        <button
                          disabled={disabled}
                          onClick={() =>
                            setEditProduct({
                              id: '',
                              name: t.name,
                              unit: t.unit,
                              stages: [{ ...t, dependencies: [] }],
                              taskId: t.id,
                            })
                          }
                        >
                          Настроить этап
                        </button>
                      )}
                      {t.kind === 'wait' ? (
                        <button
                          disabled={disabled || !t.ready}
                          onClick={() =>
                            void command(
                              t.status === 'running'
                                ? 'task.complete'
                                : 'task.start',
                              { taskId: t.id },
                            )
                          }
                        >
                          {t.status === 'running'
                            ? 'Завершить выдержку'
                            : 'Начать выдержку'}
                        </button>
                      ) : (
                        <button
                          disabled={disabled || t.status === 'running'}
                          onClick={() => openTaskForm(t, 'assign')}
                        >
                          Назначить
                        </button>
                      )}
                      {t.pin && t.status !== 'running' && (
                        <button
                          disabled={disabled}
                          onClick={() =>
                            void command('task.assign', {
                              taskId: t.id,
                              workerId: t.assignedWorkerId,
                              unpin: true,
                              clearBlock: true,
                            })
                          }
                        >
                          Снять закрепление
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
        {manager && tab === 'products' && (
          <>
            <div className="pp-heading">
              <h1>Продукты и маршруты</h1>
              <button
                className="pp-primary"
                onClick={() =>
                  setEditProduct({
                    id: '',
                    name: '',
                    unit: 'шт',
                    stages: [defaultStage()],
                  })
                }
              >
                Новый продукт
              </button>
            </div>
            <div className="pp-grid">
              {data.products.map((p) => (
                <article className="pp-card" key={p.id}>
                  <h3>{p.name}</h3>
                  {p.needsSetup && (
                    <p className="pp-warning">
                      Перенесённый маршрут: проверьте компетенции, оборудование
                      и материалы.
                    </p>
                  )}
                  <p className="pp-muted">
                    Версия {p.versions.at(-1)!.version} ·{' '}
                    {p.versions.at(-1)!.stages.length} этапов
                  </p>
                  <p>
                    {p.versions
                      .at(-1)!
                      .stages.map((s) => s.name)
                      .join(' → ')}
                  </p>
                  <button
                    onClick={() =>
                      setEditProduct({
                        id: p.id,
                        name: p.name,
                        unit: p.unit,
                        stages: structuredClone(p.versions.at(-1)!.stages),
                      })
                    }
                  >
                    Редактировать маршрут
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
        {manager && tab === 'workers' && (
          <>
            <div className="pp-heading">
              <h1>Мастера</h1>
              <button
                className="pp-primary"
                onClick={() => {
                  setEditWorker(blankWorker());
                  setNewPin('');
                }}
              >
                Добавить мастера
              </button>
            </div>
            <div className="pp-grid">
              {data.workers.map((w) => (
                <article className="pp-card" key={w.id}>
                  <h3>{w.name}</h3>
                  <p className="pp-muted">
                    {w.shiftStart}–{w.shiftEnd} ·{' '}
                    {w.enabled ? 'В плане' : 'Вне плана'}
                  </p>
                  <div className="pp-actions">
                    {w.skills.map((s) => (
                      <span className="pp-tag" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                  <p className="pp-muted">
                    {w.access ? 'Личный вход включён' : 'Без личного входа'}
                  </p>
                  <div className="pp-actions">
                    <button
                      onClick={() => {
                        setHistoryWorker(w.id);
                        setTab('history');
                      }}
                    >
                      Выполненные работы
                    </button>
                    <button
                      onClick={() => {
                        setEditWorker(structuredClone(w));
                        setNewPin('');
                      }}
                    >
                      Компетенции и доступ
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        {manager && tab === 'warehouse' && (
          <>
            <h1>Материалы производства</h1>
            <p className="pp-muted">
              Изолированный каталог пилота. Материалы и выдачи рабочего склада
              не изменяются.
            </p>
            <div className="pp-card">
              {data.warehouse.map((w) => (
                <div className="pp-row" key={w.sku}>
                  <div>
                    <strong>{w.name}</strong>
                    <p className="pp-muted">
                      {w.sku} · {w.location}
                    </p>
                  </div>
                  <span>
                    {Math.round(w.stock * 1000) / 1000} {w.unit}
                  </span>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      setRefill(w.sku);
                      setRefillQty('1');
                    }}
                  >
                    Пополнить
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        {manager && tab === 'orders' && (
          <>
            <div className="pp-heading">
              <h1>Изделия заказов</h1>
              <button
                className="pp-primary"
                onClick={() => {
                  setItemOrder(
                    data.orders.find(
                      (o) =>
                        o.status !== 'Выполненная' && o.status !== 'Отменён',
                    )?.id || '',
                  );
                  setItemProduct(data.products[0]?.id || '');
                  setAddItem(true);
                }}
              >
                Добавить изделие
              </button>
            </div>
            <div className="pp-grid">
              {data.orders.map((o) => {
                const ts = data.tasks.filter((t) => t.orderId === o.id);
                return (
                  <article className="pp-card" key={o.id}>
                    <span
                      className={`pp-tag ${o.status === 'Выполненная' ? 'pp-green' : ''}`}
                    >
                      {o.status}
                    </span>
                    <h3 className="pp-space">
                      № {o.id} · {o.name}
                    </h3>
                    <p className="pp-muted">{o.customer}</p>
                    {data.items
                      .filter((i) => i.orderId === o.id)
                      .map((i) => (
                        <div className="pp-row" key={i.id}>
                          <div>
                            <strong>
                              {i.name} · {i.quantity} {i.unit}
                            </strong>
                            <p className="pp-muted">
                              Маршрут v{i.productVersion} ·{' '}
                              {
                                ts.filter(
                                  (t) =>
                                    t.itemId === i.id && t.status === 'done',
                                ).length
                              }{' '}
                              / {ts.filter((t) => t.itemId === i.id).length}{' '}
                              этапов
                            </p>
                          </div>
                        </div>
                      ))}
                    <div className="pp-actions pp-space">
                      <a
                        href={`/kanban/?order=${o.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Карточка заказа ↗
                      </a>
                      <button
                        onClick={() => setGallery({ order: o, index: 0 })}
                      >
                        Изображения · {o.media.length}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </main>
      {gallery &&
        modal(
          gallery.order.name,
          <>
            {gallery.order.media.length ? (
              <>
                <img
                  className="pp-full-image"
                  src={gallery.order.media[gallery.index].url}
                  alt={gallery.order.media[gallery.index].name}
                />
                <p>{gallery.order.media[gallery.index].name}</p>
                <div className="pp-actions">
                  {gallery.order.media.map((m, i) => (
                    <button
                      key={m.id}
                      aria-pressed={gallery.index === i}
                      onClick={() => setGallery({ ...gallery, index: i })}
                    >
                      {i + 1} · {m.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p>
                В карточке заказа пока нет изображений.
                {manager && (
                  <>
                    {' '}
                    <a
                      href={`/kanban/?order=${gallery.order.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Добавить в карточке заказа ↗
                    </a>
                  </>
                )}
              </p>
            )}
          </>,
          () => setGallery(null),
        )}
      {taskForm &&
        modal(
          taskForm.kind === 'assign'
            ? 'Назначение и порядок'
            : taskForm.kind === 'complete'
              ? 'Выполненная часть'
              : taskForm.kind === 'delay'
                ? 'Обновить прогноз'
                : 'Препятствие или пауза',
          <>
            <h3>{taskForm.task.name}</h3>
            {taskForm.kind === 'assign' && (
              <>
                <label>
                  Ответственный
                  <select
                    value={formWorker}
                    onChange={(e) => setFormWorker(e.target.value)}
                  >
                    <option value="">Выберите мастера</option>
                    {data.workers
                      .filter((w) => w.skills.includes(taskForm.task.skill))
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Порядок в очереди
                  <input
                    type="number"
                    min="0"
                    value={formRank}
                    onChange={(e) => setFormRank(e.target.value)}
                  />
                </label>
                <label>
                  Обязательно закончить к дате
                  <input
                    type="date"
                    value={formMustDate}
                    onChange={(e) => setFormMustDate(e.target.value)}
                  />
                </label>
                <label>
                  Закрепить начало, если необходимо
                  <input
                    type="datetime-local"
                    value={formStart}
                    onChange={(e) => setFormStart(e.target.value)}
                  />
                </label>
                <p className="pp-muted">
                  Выбранное время интерпретируется в часовом поясе устройства.
                  Назначение сохраняется при пересчёте; зависимости и занятость
                  обязательны.
                </p>
              </>
            )}
            {['assign', 'delay'].includes(taskForm.kind) && (
              <label>
                {taskForm.kind === 'delay'
                  ? 'Осталось минут'
                  : 'Плановая длительность, мин'}
                <input
                  type="number"
                  min="1"
                  value={formMinutes}
                  onChange={(e) => setFormMinutes(e.target.value)}
                />
              </label>
            )}
            {taskForm.kind === 'complete' && (
              <label>
                Выполнено, {taskForm.task.unit}
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={formQty}
                  onChange={(e) => setFormQty(e.target.value)}
                />
              </label>
            )}
            {['pause', 'block'].includes(taskForm.kind) && (
              <label>
                Что мешает работе
                <input
                  value={formReason}
                  onChange={(e) => setFormReason(e.target.value)}
                  placeholder="Материал, оборудование, чертёж…"
                />
              </label>
            )}
            <button
              className="pp-primary pp-space"
              disabled={disabled}
              onClick={() => void saveTaskForm()}
            >
              Сохранить
            </button>
          </>,
          () => setTaskForm(null),
        )}
      {editProduct &&
        modal(
          'Маршрут продукта',
          <>
            <div className={editProduct.taskId ? 'hidden' : 'pp-form-grid'}>
              <label>
                Название
                <input
                  value={editProduct.name}
                  onChange={(e) =>
                    setEditProduct({ ...editProduct, name: e.target.value })
                  }
                />
              </label>
              <label>
                Единица
                <input
                  value={editProduct.unit}
                  onChange={(e) =>
                    setEditProduct({ ...editProduct, unit: e.target.value })
                  }
                />
              </label>
            </div>
            {editProduct.stages.map((s, i) => (
              <details className="pp-stage-editor" key={s.id} open>
                <summary>
                  {i + 1}. {s.name} · {s.minutes} мин
                </summary>
                <div className="pp-form-grid">
                  <label>
                    Этап
                    <input
                      value={s.name}
                      onChange={(e) => editStage(i, { name: e.target.value })}
                    />
                  </label>
                  <label>
                    Тип
                    <select
                      value={s.kind}
                      onChange={(e) =>
                        editStage(i, { kind: e.target.value as Stage['kind'] })
                      }
                    >
                      <option value="manual">Ручная работа</option>
                      <option value="machine">
                        Оборудование с автономным циклом
                      </option>
                      <option value="wait">Технологическое ожидание</option>
                    </select>
                  </label>
                  <label>
                    Компетенция
                    <input
                      value={s.skill}
                      disabled={s.kind === 'wait'}
                      onChange={(e) => editStage(i, { skill: e.target.value })}
                    />
                  </label>
                  <label>
                    Рабочее место
                    <select
                      value={s.resourceId}
                      onChange={(e) =>
                        editStage(i, { resourceId: e.target.value })
                      }
                    >
                      <option value="">Без оборудования</option>
                      {data.resources.map((r) => (
                        <option value={r.id} key={r.id}>
                          {r.name} · {r.zone}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Весь этап для позиции, мин
                    <input
                      type="number"
                      min="1"
                      value={s.minutes}
                      onChange={(e) =>
                        editStage(i, { minutes: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                {s.kind === 'machine' && (
                  <div className="pp-form-grid">
                    {(
                      [
                        ['setupMinutes', 'Запуск, мин'],
                        ['finishMinutes', 'Снятие результата, мин'],
                        ['controlEvery', 'Контроль каждые, мин (0 — нет)'],
                        ['controlMinutes', 'Длительность контроля, мин'],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          type="number"
                          min="0"
                          value={s[key]}
                          onChange={(e) =>
                            editStage(i, { [key]: Number(e.target.value) })
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}
                <fieldset>
                  <legend>Начать после</legend>
                  {editProduct.stages
                    .filter((other) => other.id !== s.id)
                    .map((other) => (
                      <label className="pp-check" key={other.id}>
                        <input
                          type="checkbox"
                          checked={s.dependencies.includes(other.id)}
                          onChange={(e) =>
                            editStage(i, {
                              dependencies: e.target.checked
                                ? [...s.dependencies, other.id]
                                : s.dependencies.filter(
                                    (id) => id !== other.id,
                                  ),
                            })
                          }
                        />
                        {other.name}
                      </label>
                    ))}
                </fieldset>
                <fieldset>
                  <legend>Материалы на единицу изделия</legend>
                  {s.materials.map((m, n) => (
                    <div className="pp-form-grid" key={n}>
                      <label>
                        Материал
                        <select
                          value={m.sku}
                          onChange={(e) =>
                            editStage(i, {
                              materials: s.materials.map((v, j) =>
                                j === n ? { ...v, sku: e.target.value } : v,
                              ),
                            })
                          }
                        >
                          {data.warehouse.map((w) => (
                            <option key={w.sku} value={w.sku}>
                              {w.name} · {w.unit}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Количество
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={m.quantity}
                          onChange={(e) =>
                            editStage(i, {
                              materials: s.materials.map((v, j) =>
                                j === n
                                  ? { ...v, quantity: Number(e.target.value) }
                                  : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <button
                        onClick={() =>
                          editStage(i, {
                            materials: s.materials.filter((_, j) => j !== n),
                          })
                        }
                      >
                        Убрать материал
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      editStage(i, {
                        materials: [
                          ...s.materials,
                          { sku: data.warehouse[0]?.sku || '', quantity: 1 },
                        ],
                      })
                    }
                  >
                    Добавить материал
                  </button>
                </fieldset>
                <button
                  onClick={() =>
                    setEditProduct({
                      ...editProduct,
                      stages: editProduct.taskId
                        ? editProduct.stages
                        : editProduct.stages.filter((_, j) => j !== i),
                    })
                  }
                >
                  Удалить этап
                </button>
              </details>
            ))}
            <div className="pp-actions pp-space">
              <button
                onClick={() =>
                  setEditProduct({
                    ...editProduct,
                    stages: editProduct.taskId
                      ? editProduct.stages
                      : [...editProduct.stages, defaultStage()],
                  })
                }
              >
                Добавить этап
              </button>
              <button
                className="pp-primary"
                disabled={disabled}
                onClick={async () => {
                  if (
                    await command(
                      editProduct.taskId ? 'task.configure' : 'product.save',
                      editProduct.taskId
                        ? {
                            taskId: editProduct.taskId,
                            stage: editProduct.stages[0],
                          }
                        : editProduct,
                    )
                  )
                    setEditProduct(null);
                }}
              >
                {editProduct.taskId
                  ? 'Сохранить этап'
                  : 'Сохранить новую версию'}
              </button>
            </div>
            <p className="pp-muted">
              {editProduct.taskId
                ? 'Изменяется только выбранный ещё не начатый этап.'
                : 'Запущенные изделия сохраняют прежний маршрут.'}{' '}
              Время пока задаётся на весь этап позиции; расчёт по размерам и
              элементам добавится позже.
            </p>
          </>,
          () => setEditProduct(null),
        )}
      {editWorker &&
        modal(
          'Профиль мастера',
          <>
            <label>
              Имя
              <input
                value={editWorker.name}
                onChange={(e) =>
                  setEditWorker({ ...editWorker, name: e.target.value })
                }
              />
            </label>
            <label>
              Компетенции — по одной в строке
              <textarea
                rows={4}
                value={editWorker.skills.join('\n')}
                onChange={(e) =>
                  setEditWorker({
                    ...editWorker,
                    skills: e.target.value
                      .split('\n')
                      .map((s) => s.trimStart()),
                  })
                }
              />
            </label>
            <fieldset>
              <legend>Выбрать из маршрутов</legend>
              {[...new Set(data.tasks.map((t) => t.skill).filter(Boolean))].map(
                (skill) => (
                  <label key={skill} className="pp-check">
                    <input
                      type="checkbox"
                      checked={editWorker.skills.includes(skill)}
                      onChange={(e) =>
                        setEditWorker({
                          ...editWorker,
                          skills: e.target.checked
                            ? [...editWorker.skills, skill]
                            : editWorker.skills.filter((s) => s !== skill),
                        })
                      }
                    />
                    {skill}
                  </label>
                ),
              )}
            </fieldset>
            <div className="pp-form-grid">
              <label>
                Начало смены
                <input
                  type="time"
                  value={editWorker.shiftStart}
                  onChange={(e) =>
                    setEditWorker({ ...editWorker, shiftStart: e.target.value })
                  }
                />
              </label>
              <label>
                Конец смены
                <input
                  type="time"
                  value={editWorker.shiftEnd}
                  onChange={(e) =>
                    setEditWorker({ ...editWorker, shiftEnd: e.target.value })
                  }
                />
              </label>
            </div>
            <fieldset>
              <legend>Рабочие дни</legend>
              <div className="pp-actions">
                {['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'].map((day, i) => (
                  <label className="pp-check" key={day}>
                    <input
                      type="checkbox"
                      checked={editWorker.days.includes(i)}
                      onChange={(e) =>
                        setEditWorker({
                          ...editWorker,
                          days: e.target.checked
                            ? [...editWorker.days, i]
                            : editWorker.days.filter((d) => d !== i),
                        })
                      }
                    />
                    {day}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Рабочие зоны</legend>
              {[...new Set(data.resources.map((r) => r.zone))].map((zone) => (
                <label className="pp-check" key={zone}>
                  <input
                    type="checkbox"
                    checked={editWorker.zones.includes(zone)}
                    onChange={(e) =>
                      setEditWorker({
                        ...editWorker,
                        zones: e.target.checked
                          ? [...editWorker.zones, zone]
                          : editWorker.zones.filter((z) => z !== zone),
                      })
                    }
                  />
                  {zone}
                </label>
              ))}
            </fieldset>
            <label>
              Роль
              <select
                value={editWorker.role}
                onChange={(e) =>
                  setEditWorker({
                    ...editWorker,
                    role: e.target.value as Worker['role'],
                  })
                }
              >
                <option value="master">Мастер</option>
                <option value="lead">Руководитель производства</option>
              </select>
            </label>
            <label className="pp-check">
              <input
                type="checkbox"
                checked={editWorker.enabled}
                onChange={(e) =>
                  setEditWorker({ ...editWorker, enabled: e.target.checked })
                }
              />
              Назначать задачи
            </label>
            <label className="pp-check">
              <input
                type="checkbox"
                checked={editWorker.access}
                disabled={!editWorker.hasPin}
                onChange={(e) =>
                  setEditWorker({ ...editWorker, access: e.target.checked })
                }
              />
              Разрешить личный вход
            </label>
            {editWorker.id && (
              <div className="pp-details">
                <p className="pp-muted">Логин мастера: {editWorker.id}</p>
                <label>
                  Новый код доступа, 6–12 цифр
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value)}
                  />
                </label>
                <button
                  disabled={disabled || !/^\d{6,12}$/.test(newPin)}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await fetch('/api/production-pilot/access', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          workerId: editWorker.id,
                          pin: newPin,
                        }),
                      });
                      const v = await r.json();
                      if (!r.ok) throw new Error(v.error);
                      setNewPin('');
                      setEditWorker({ ...editWorker, hasPin: true });
                      await load();
                    } catch (e) {
                      setError(
                        e instanceof Error ? e.message : 'Ошибка доступа',
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Задать код доступа
                </button>
                <p className="pp-muted">
                  После задания кода включите личный вход и сохраните профиль.
                  Для проверки отдельного входа откройте этот адрес в приватном
                  окне.
                </p>
              </div>
            )}
            <button
              className="pp-primary pp-space"
              disabled={disabled}
              onClick={async () => {
                if (
                  await command('worker.save', {
                    ...editWorker,
                    skills: editWorker.skills
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                )
                  setEditWorker(null);
              }}
            >
              Сохранить профиль
            </button>
          </>,
          () => setEditWorker(null),
        )}
      {addItem &&
        modal(
          'Новое изделие заказа',
          <>
            <label>
              Заказ
              <select
                value={itemOrder}
                onChange={(e) => setItemOrder(e.target.value)}
              >
                {data.orders
                  .filter((o) => o.status !== 'Выполненная')
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      № {o.id} · {o.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Продукт
              <select
                value={itemProduct}
                onChange={(e) => setItemProduct(e.target.value)}
              >
                {data.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · версия {p.versions.at(-1)!.version}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Количество
              <input
                type="number"
                step="any"
                value={itemQty}
                onChange={(e) => setItemQty(e.target.value)}
              />
            </label>
            <button
              className="pp-primary pp-space"
              disabled={disabled}
              onClick={async () => {
                if (
                  await command('item.add', {
                    orderId: itemOrder,
                    productId: itemProduct,
                    quantity: Number(itemQty),
                  })
                )
                  setAddItem(false);
              }}
            >
              Создать цепочку и включить в план
            </button>
          </>,
          () => setAddItem(false),
        )}
      {refill &&
        modal(
          'Пополнить тестовый остаток',
          <>
            <p>{data.warehouse.find((w) => w.sku === refill)?.name}</p>
            <label>
              Количество
              <input
                type="number"
                step="any"
                min="0"
                value={refillQty}
                onChange={(e) => setRefillQty(e.target.value)}
              />
            </label>
            <button
              className="pp-primary pp-space"
              disabled={disabled}
              onClick={async () => {
                if (
                  await command('warehouse.refill', {
                    sku: refill,
                    quantity: Number(refillQty),
                  })
                )
                  setRefill('');
              }}
            >
              Пополнить
            </button>
          </>,
          () => setRefill(''),
        )}
    </div>
  );
}
