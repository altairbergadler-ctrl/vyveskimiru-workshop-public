'use client';

/* oxlint-disable next/no-img-element -- Private runtime photos use native lazy loading. */

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  CircleGauge,
  Clock3,
  History,
  ImagePlus,
  MapPin,
  PackageCheck,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';

type WarehousePeriod = 7 | 30 | 90;
type PendingRefill = { requestId: string; code: string; quantity: number; name: string; unit: string };
const refillStorageKey = 'workshop.pending-refill.v1';
function storedRefill(): PendingRefill | null {
  const raw = localStorage.getItem(refillStorageKey);
  if (!raw) return null;
  const saved = JSON.parse(raw);
  if (typeof saved.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(saved.requestId)
    || typeof saved.code !== 'string' || typeof saved.name !== 'string' || typeof saved.unit !== 'string'
    || !Number.isFinite(saved.quantity) || saved.quantity <= 0)
    throw new Error('Не удалось прочитать сохранённое пополнение. Нужна проверка перед новой записью.');
  return saved;
}
type WarehouseFilter = 'all' | 'low' | 'materials' | 'electronics';
type WarehouseItem = {
  id: string;
  sku: string;
  name: string;
  category: string;
  expenseCategory: string;
  group: 'materials' | 'electronics' | 'printing';
  unit: string;
  price: number;
  stock: number;
  reserved: number;
  minStock: number;
  used: Record<WarehousePeriod, number>;
  location: string;
  lastMovement: string;
  photoUrl?: string | null;
};

type ItemEditorState =
  | { mode: 'create' }
  | { mode: 'edit'; item: WarehouseItem };

const filters: Array<{ value: WarehouseFilter; label: string }> = [
  { value: 'all', label: 'Все товары' },
  { value: 'low', label: 'Заканчиваются' },
  { value: 'materials', label: 'Материалы' },
  { value: 'electronics', label: 'Электрика' },
];

function formatQuantity(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(
    value,
  );
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(value);
}

function formNumber(value: FormDataEntryValue | null) {
  return Number((typeof value === 'string' ? value : '').replace(',', '.'));
}

function formText(value: FormDataEntryValue | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function stockStatus(item: WarehouseItem) {
  const available = item.stock - item.reserved;
  if (available <= 0)
    return { label: 'Нет свободного остатка', tone: 'danger' as const };
  if (available <= item.minStock)
    return { label: 'Нужно пополнить', tone: 'warning' as const };
  return { label: 'Запас в норме', tone: 'good' as const };
}

function ProductPhoto({
  item,
  className = '',
}: {
  item: WarehouseItem;
  className?: string;
}) {
  const photoIndex =
    Array.from(item.sku).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 8;
  const x = (photoIndex % 4) * (100 / 3);
  const y = Math.floor(photoIndex / 4) * 100;
  return (
    <div
      className={`relative shrink-0 overflow-hidden bg-[#e9e7e3] bg-no-repeat ${className}`}
      style={{
        backgroundImage: "url('/warehouse/product-sprite.png')",
        backgroundPosition: `${x}% ${y}%`,
        backgroundSize: '400% 200%',
      }}
      title={`Фото товара: ${item.name}`}
    >
      {item.photoUrl && (
        <img
          src={item.photoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full bg-white object-contain p-1.5"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
    </div>
  );
}

export default function WarehousePage({
  onBack,
  expenseCategories,
  initialSku,
  initialRefill,
}: {
  initialSku?: string;
  initialRefill?: boolean;
  onBack: () => void;
  expenseCategories: string[];
}) {
  const [items, setItems] = useState<WarehouseItem[]>([]);
  const [period, setPeriod] = useState<WarehousePeriod>(30);
  const [filter, setFilter] = useState<WarehouseFilter>('all');
  const [search, setSearch] = useState(initialSku || '');
  const targetOpened = useRef(false);
  const [refillItem, setRefillItem] = useState<WarehouseItem | null>(null);
  const [refillAmount, setRefillAmount] = useState('');
  const [pendingRefill, setPendingRefill] = useState<PendingRefill | null>(null);
  const refillBusy = useRef(false);
  const [itemEditor, setItemEditor] = useState<ItemEditorState | null>(null);
  const [editorPhoto, setEditorPhoto] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadWarehouse = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/warehouse');
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || 'Не удалось загрузить склад');
      setItems(payload.items ?? []);
      if (initialSku && !targetOpened.current) {
        const target = (payload.items as WarehouseItem[]).find(item => item.sku === initialSku);
        if (target && initialRefill) setRefillItem(target);
        targetOpened.current = true;
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Не удалось загрузить склад',
      );
    } finally {
      setLoading(false);
    }
  }, [initialSku, initialRefill]);

  useEffect(() => {
    queueMicrotask(() => void loadWarehouse());
    const restore = () => {
      try { setPendingRefill(storedRefill()); }
      catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось восстановить пополнение'); }
    };
    queueMicrotask(restore);
    const sync = (event: StorageEvent) => {
      if (event.key !== refillStorageKey) return;
      restore();
      if (!event.newValue) {
        setRefillItem(null); setRefillAmount('');
        setNotice('Состояние пополнения изменилось в другой вкладке.');
        void loadWarehouse();
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [loadWarehouse]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru-RU');
    return items
      .filter((item) => {
        if (filter === 'low' && stockStatus(item).tone === 'good') return false;
        if (filter === 'materials' && item.group !== 'materials') return false;
        if (filter === 'electronics' && item.group !== 'electronics')
          return false;
        return (
          !query ||
          [item.name, item.sku, item.category, item.location].some((value) =>
            value.toLocaleLowerCase('ru-RU').includes(query),
          )
        );
      })
      .sort((a, b) => {
        const aLow = stockStatus(a).tone === 'good' ? 1 : 0;
        const bLow = stockStatus(b).tone === 'good' ? 1 : 0;
        return aLow - bLow || a.name.localeCompare(b.name, 'ru-RU');
      });
  }, [filter, items, search]);

  const lowItems = items.filter((item) => stockStatus(item).tone !== 'good');
  const reservedItems = items.filter((item) => item.reserved > 0);
  const withoutMovement = items.filter((item) => item.used[period] === 0);

  function openRefill(item?: WarehouseItem) {
    setRefillItem(item ?? items[0]);
    setRefillAmount('');
    setNotice('');
  }

  function openNewItem() {
    setItemEditor({ mode: 'create' });
    setEditorPhoto('');
    setNotice('');
  }

  function openItemEditor(item: WarehouseItem) {
    setItemEditor({ mode: 'edit', item });
    setEditorPhoto(item.photoUrl ?? '');
    setNotice('');
  }

  function readEditorPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result !== 'string') return;
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, 1000 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas
          .getContext('2d')
          ?.drawImage(image, 0, 0, canvas.width, canvas.height);
        setEditorPhoto(canvas.toDataURL('image/jpeg', 0.82));
      };
      image.src = reader.result;
    });
    reader.readAsDataURL(file);
  }

  async function submitItem(event: {
    preventDefault(): void;
    currentTarget: HTMLFormElement;
  }) {
    event.preventDefault();
    if (!itemEditor) return;
    const values = new FormData(event.currentTarget);
    const name = formText(values.get('name'));
    const sku = formText(values.get('sku'));
    const category = formText(values.get('category')) || 'Материалы';
    const expenseCategory = formText(values.get('expenseCategory'));
    const unit = formText(values.get('unit'));
    const location = formText(values.get('location'));
    const stock = formNumber(values.get('stock'));
    const reserved = formNumber(values.get('reserved'));
    const minStock = formNumber(values.get('minStock'));
    if (
      !name ||
      !sku ||
      !expenseCategory ||
      !unit ||
      !location ||
      [stock, reserved, minStock].some(
        (value) => !Number.isFinite(value) || value < 0,
      )
    )
      return;

    setSaving(true);
    setError('');
    try {
      const editing = itemEditor.mode === 'edit';
      const url = editing
        ? `/api/warehouse/items/${encodeURIComponent(itemEditor.item.sku)}`
        : '/api/warehouse/items';
      const response = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          sku,
          category,
          expenseCategory,
          unit,
          stock,
          reserved,
          minStock,
          location,
          photoUrl: editorPhoto,
        }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || 'Не удалось сохранить позицию');
      setItems(payload.items ?? []);
      setNotice(
        editing
          ? `${name}: изменения сохранены в Google Таблице`
          : `${name}: позиция добавлена в Google Таблицу`,
      );
      setItemEditor(null);
      setEditorPhoto('');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Не удалось сохранить позицию',
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitRefill(event: {
    preventDefault(): void;
    currentTarget: HTMLFormElement;
  }) {
    event.preventDefault();
    if (refillBusy.current) return;
    const amount = Number(refillAmount.replace(',', '.'));
    if (!pendingRefill && (!refillItem || !Number.isFinite(amount) || amount <= 0)) return;
    refillBusy.current = true;
    setSaving(true);
    setError('');
    try {
      if (!navigator.locks) throw new Error('Обновите браузер для безопасного сохранения пополнения.');
      await navigator.locks.request(refillStorageKey, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Пополнение уже проверяется в другой вкладке. Дождитесь результата.');
        const saved = storedRefill();
        // Serialize tabs and persist the identity before any network request.
        const command: PendingRefill = saved ?? pendingRefill ?? {
          requestId: crypto.randomUUID(), code: refillItem!.sku, quantity: Math.round(amount * 100) / 100,
          name: refillItem!.name, unit: refillItem!.unit,
        };
        localStorage.setItem(refillStorageKey, JSON.stringify(command));
        setPendingRefill(command);
        const response = await fetch('/api/warehouse/movements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: command.requestId, code: command.code, quantity: command.quantity }),
          signal: AbortSignal.timeout(90000),
        });
        const payload = await response.json();
        if (!response.ok) {
          if (['not_submitted', 'rejected'].includes(payload.receiptState)) {
            localStorage.removeItem(refillStorageKey); setPendingRefill(null);
          }
          throw new Error(payload.error || 'Не удалось пополнить остаток');
        }
        if (payload.refill?.id !== command.requestId || payload.refill?.state !== 'confirmed')
          throw new Error('Нет подтверждения пополнения. Сохранённую операцию можно проверить повторно.');
        setItems(payload.items ?? []);
        setNotice(
          `${command.name}: подтверждено ${formatQuantity(command.quantity)} ${command.unit} в Google Таблице`,
        );
        localStorage.removeItem(refillStorageKey);
        setPendingRefill(null);
        setRefillItem(null);
        setRefillAmount('');
      });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Не удалось пополнить остаток',
      );
    } finally {
      refillBusy.current = false;
      setSaving(false);
    }
  }

  const activeRefillItem = pendingRefill ? items.find(item => item.sku === pendingRefill.code) : refillItem
    ? (items.find((item) => item.id === refillItem.id) ?? refillItem)
    : null;

  const editorExpenseCategories = useMemo(() => {
    const current = itemEditor?.mode === 'edit' ? itemEditor.item.expenseCategory : '';
    return current && !expenseCategories.includes(current)
      ? [current, ...expenseCategories]
      : expenseCategories;
  }, [expenseCategories, itemEditor]);

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-7 lg:px-10 lg:py-9">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 mb-2 text-muted-foreground"
            onClick={onBack}
          >
            <ChevronLeft />
            На главную
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Учёт материалов и комплектующих
            </p>
            <span className="rounded-full bg-[#eef7da] px-2 py-0.5 text-[11px] font-medium text-[#5c7f24]">
              Google Таблица
            </span>
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            Склад
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="hidden h-10 sm:inline-flex"
            onClick={() =>
              document
                .getElementById('warehouse-rules')
                ?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            <History />
            Как устроено
          </Button>
          <Button
            variant="outline"
            className="h-10 flex-1 sm:flex-none"
            onClick={() => openRefill()}
          >
            <Plus />
            Пополнить
          </Button>
          <Button
            className="h-10 flex-1 bg-[#171b18] text-white hover:bg-[#2a302b] sm:flex-none"
            onClick={openNewItem}
          >
            <PackagePlus />
            Новая позиция
          </Button>
        </div>
      </div>

      {notice && (
        <output className="mt-5 flex items-center gap-2 rounded-2xl border border-[#b5f23c]/40 bg-[#f1f9e4] px-4 py-3 text-sm text-[#4d6d1e]">
          <CheckCircle2 className="size-4" />
          {notice}
        </output>
      )}

      {error && (
        <div
          className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#ef755e]/30 bg-[#fff7f4] px-4 py-3 text-sm text-[#743c31]"
          role="alert"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadWarehouse()}
          >
            Повторить
          </Button>
        </div>
      )}

      <section
        className="mt-7 grid grid-cols-2 gap-3 xl:grid-cols-4"
        aria-label="Показатели склада"
      >
        <article className="rounded-[20px] bg-[#171b18] p-5 text-white">
          <div className="flex items-center justify-between">
            <p className="text-sm text-white/55">Товаров на складе</p>
            <Boxes className="size-5 text-[#b5f23c]" />
          </div>
          <p className="mt-4 text-3xl font-semibold">{items.length}</p>
          <p className="mt-2 text-xs text-white/45">позиций в Google Таблице</p>
        </article>
        <article className="rounded-[20px] border border-[#ef755e]/20 bg-[#fff7f4] p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[#955242]">Заканчиваются</p>
            <AlertTriangle className="size-5 text-[#cf624d]" />
          </div>
          <p className="mt-4 text-3xl font-semibold text-[#743c31]">
            {lowItems.length}
          </p>
          <p className="mt-2 text-xs text-[#a56557]">
            ниже минимального запаса
          </p>
        </article>
        <article className="rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">В резерве</p>
            <ShieldCheck className="size-5 text-[#6d942c]" />
          </div>
          <p className="mt-4 text-3xl font-semibold">{reservedItems.length}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            позиций под заказы
          </p>
        </article>
        <article className="rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Без движения</p>
            <Clock3 className="size-5 text-[#6d942c]" />
          </div>
          <p className="mt-4 text-3xl font-semibold">
            {withoutMovement.length}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            за последние {period} дней
          </p>
        </article>
      </section>

      {lowItems.length > 0 && (
        <section
          className="mt-5 overflow-hidden rounded-[22px] border border-[#ef755e]/20 bg-[#fff7f4]"
          aria-label="Нужно пополнить"
        >
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-white text-[#c35642] shadow-sm">
                <ArrowDownToLine className="size-5" />
              </div>
              <div>
                <h2 className="font-semibold text-[#743c31]">
                  Пора заказать {lowItems.length} позиции
                </h2>
                <p className="mt-1 text-sm text-[#a56557]">
                  Свободный остаток уже ниже установленного минимума.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-[#ef755e]/30 bg-white text-[#743c31]"
              onClick={() => {
                setFilter('low');
                document
                  .getElementById('warehouse-catalog')
                  ?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              Показать список
            </Button>
          </div>
        </section>
      )}

      <section
        id="warehouse-catalog"
        className="mt-5 rounded-[22px] border border-border bg-card p-4 sm:p-5"
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative min-w-0 flex-1 xl:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Название, артикул или место…"
              className="h-10 pl-9"
              aria-label="Поиск товаров на складе"
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl bg-muted p-1 text-xs">
              {filters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={`shrink-0 rounded-lg px-3 py-2 transition ${filter === option.value ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-start">
              <span className="text-xs text-muted-foreground">Расход за</span>
              <NativeSelect
                value={period}
                onChange={(event) =>
                  setPeriod(Number(event.target.value) as WarehousePeriod)
                }
                className="w-28"
              >
                <NativeSelectOption value={7}>7 дней</NativeSelectOption>
                <NativeSelectOption value={30}>30 дней</NativeSelectOption>
                <NativeSelectOption value={90}>90 дней</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        </div>
      </section>

      {loading && (
        <div className="mt-4 rounded-[22px] border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          Загружаю данные из Google Таблицы…
        </div>
      )}

      <div className="mt-4 space-y-3">
        {filteredItems.map((item) => {
          const available = Math.max(item.stock - item.reserved, 0);
          const status = stockStatus(item);
          const fill = Math.min(
            100,
            Math.round((available / Math.max(item.minStock * 2, 1)) * 100),
          );
          return (
            <article
              key={item.id}
              className="overflow-hidden rounded-[22px] border border-border bg-card transition hover:border-[#9bd226]/50 hover:shadow-sm"
            >
              <div className="grid gap-4 p-4 sm:grid-cols-[104px_minmax(0,1fr)] sm:p-5 xl:grid-cols-[112px_minmax(200px,1.35fr)_minmax(132px,.6fr)_minmax(138px,.68fr)_minmax(108px,.5fr)_minmax(138px,.68fr)_auto] xl:items-center">
                <ProductPhoto
                  item={item}
                  className="size-24 rounded-2xl sm:size-[104px] xl:size-28"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                      {item.sku}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {item.category}
                    </span>
                  </div>
                  <h2 className="mt-2 font-semibold leading-snug">
                    {item.name}
                  </h2>
                  <div className="mt-2 inline-flex flex-wrap items-baseline gap-x-1.5 rounded-xl border border-[#b5f23c]/55 bg-[#f6fbe9] px-2.5 py-1.5 xl:hidden">
                    <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#657342]">
                      Стоимость
                    </span>
                    <span className="font-semibold tabular-nums">
                      {formatMoney(item.price)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      / {item.unit}
                    </span>
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MapPin className="size-3.5" />
                    {item.location}
                  </p>
                </div>
                <div className="hidden min-w-0 xl:block">
                  <div className="rounded-2xl border border-[#b5f23c]/55 bg-[#f6fbe9] px-3.5 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#657342]">
                      Стоимость
                    </p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">
                      {formatMoney(item.price)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      за {item.unit} · колонка E
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Свободный остаток
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatQuantity(available)}{' '}
                    <span className="text-sm font-normal text-muted-foreground">
                      {item.unit}
                    </span>
                  </p>
                  <div className="mt-2 h-1.5 max-w-36 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${status.tone === 'good' ? 'bg-[#9bd226]' : status.tone === 'warning' ? 'bg-[#f0b44c]' : 'bg-[#ef755e]'}`}
                      style={{ width: `${fill}%` }}
                    />
                  </div>
                  <p
                    className={`mt-1.5 text-[11px] ${status.tone === 'good' ? 'text-[#5c7f24]' : 'text-[#a56557]'}`}
                  >
                    {status.label} · мин. {formatQuantity(item.minStock)}{' '}
                    {item.unit}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Использовано</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatQuantity(item.used[period])}{' '}
                    <span className="text-sm font-normal text-muted-foreground">
                      {item.unit}
                    </span>
                  </p>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    за {period} дней
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Учтено всего</p>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="font-medium tabular-nums">
                      {formatQuantity(item.stock)} {item.unit}
                    </span>
                    {item.reserved > 0 && (
                      <span className="text-xs text-muted-foreground">
                        резерв {formatQuantity(item.reserved)}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                    <History className="size-3.5 shrink-0" />
                    {item.lastMovement}
                  </p>
                </div>
                <div className="flex gap-2 xl:flex-col">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => openItemEditor(item)}
                  >
                    <Pencil />
                    Изменить
                  </Button>
                  <Button
                    variant={status.tone === 'good' ? 'outline' : 'default'}
                    size="sm"
                    className={`flex-1 ${status.tone === 'good' ? '' : 'bg-[#171b18] text-white hover:bg-[#2a302b]'}`}
                    onClick={() => openRefill(item)}
                  >
                    <Plus />
                    Пополнить
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {!loading && filteredItems.length === 0 && (
        <div className="mt-4 rounded-[22px] border border-dashed border-border bg-card py-16 text-center">
          <PackageCheck className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            По выбранным условиям товары не найдены
          </p>
        </div>
      )}

      <section
        id="warehouse-rules"
        className="mt-5 grid gap-3 lg:grid-cols-3"
        aria-label="Правила учёта"
      >
        <article className="rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center gap-2 font-medium">
            <CircleGauge className="size-4 text-[#6d942c]" />
            Минимальный остаток
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Для каждой позиции задаётся свой порог. Склад заранее покажет, что
            пора заказывать.
          </p>
        </article>
        <article className="rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-4 text-[#6d942c]" />
            Резерв под заказ
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Зарезервированное видно отдельно и не считается свободным остатком.
          </p>
        </article>
        <article className="rounded-[20px] border border-border bg-card p-5">
          <div className="flex items-center gap-2 font-medium">
            <History className="size-4 text-[#6d942c]" />
            Журнал движений
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Поступление, выдача, возврат и списание сохраняются отдельными
            операциями.
          </p>
        </article>
      </section>

      <Dialog
        open={Boolean(itemEditor)}
        onOpenChange={(open) => {
          if (!open) setItemEditor(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <form
            key={itemEditor?.mode === 'edit' ? itemEditor.item.id : 'new-item'}
            onSubmit={submitItem}
          >
            <DialogHeader>
              <DialogTitle className="text-xl">
                {itemEditor?.mode === 'edit'
                  ? 'Изменить позицию'
                  : 'Новая позиция'}
              </DialogTitle>
              <DialogDescription>
                Единица измерения задаётся свободно. Изменение остатка
                сохранится отдельной корректировкой в журнале движений.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="item-name">Название товара</Label>
                <Input
                  id="item-name"
                  name="name"
                  defaultValue={
                    itemEditor?.mode === 'edit' ? itemEditor.item.name : ''
                  }
                  placeholder="Например, профиль алюминиевый 20 мм"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="item-sku">Артикул</Label>
                <Input
                  id="item-sku"
                  name="sku"
                  defaultValue={
                    itemEditor?.mode === 'edit' ? itemEditor.item.sku : ''
                  }
                  placeholder="ПРФ-20"
                  disabled={itemEditor?.mode === 'edit'}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="item-category">Категория</Label>
                <Input
                  id="item-category"
                  name="category"
                  defaultValue={
                    itemEditor?.mode === 'edit'
                      ? itemEditor.item.category
                      : 'Материалы'
                  }
                  placeholder="Материалы, Электрика…"
                  required
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="item-expense-category">Категория расхода</Label>
                <NativeSelect
                  className="w-full"
                  id="item-expense-category"
                  name="expenseCategory"
                  defaultValue={
                    itemEditor?.mode === 'edit'
                      ? itemEditor.item.expenseCategory
                      : expenseCategories[0]
                  }
                  required
                >
                  {editorExpenseCategories.map((category) => (
                    <NativeSelectOption key={category} value={category}>
                      {category}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">
                  Используется в форме «Новый расход».
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="item-unit">Единица измерения</Label>
                <Input
                  id="item-unit"
                  name="unit"
                  defaultValue={
                    itemEditor?.mode === 'edit' ? itemEditor.item.unit : ''
                  }
                  placeholder="шт, м², рулон, комплект…"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Можно вписать любое своё обозначение.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="item-stock">Остаток</Label>
                <Input
                  id="item-stock"
                  name="stock"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  defaultValue={
                    itemEditor?.mode === 'edit' ? itemEditor.item.stock : 0
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="item-reserved">В резерве</Label>
                <Input
                  id="item-reserved"
                  name="reserved"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  defaultValue={
                    itemEditor?.mode === 'edit' ? itemEditor.item.reserved : 0
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="item-min-stock">Минимальный остаток</Label>
                <Input
                  id="item-min-stock"
                  name="minStock"
                  type="number"
                  min="0"
                  step="0.1"
                  inputMode="decimal"
                  defaultValue={
                    itemEditor?.mode === 'edit' ? itemEditor.item.minStock : 0
                  }
                  required
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="item-location">Место хранения</Label>
                <Input
                  id="item-location"
                  name="location"
                  defaultValue={
                    itemEditor?.mode === 'edit' ? itemEditor.item.location : ''
                  }
                  placeholder="Стеллаж, полка или зона"
                  required
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="item-photo">Фото товара</Label>
                <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border p-3">
                  {editorPhoto ? (
                    <div
                      className="size-20 shrink-0 rounded-xl bg-cover bg-center"
                      style={{ backgroundImage: `url(${editorPhoto})` }}
                      title="Новое фото товара"
                    />
                  ) : itemEditor?.mode === 'edit' ? (
                    <ProductPhoto
                      item={itemEditor.item}
                      className="size-20 rounded-xl"
                    />
                  ) : (
                    <div className="grid size-20 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                      <ImagePlus className="size-6" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="item-photo"
                      className="inline-flex min-h-9 cursor-pointer items-center rounded-lg border border-border bg-background px-3 text-sm font-medium transition hover:bg-muted"
                    >
                      <ImagePlus className="mr-2 size-4" />
                      Выбрать фото
                    </label>
                    <Input
                      id="item-photo"
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={readEditorPhoto}
                    />
                    {editorPhoto && (
                      <button
                        type="button"
                        className="ml-3 text-xs text-muted-foreground underline underline-offset-2"
                        onClick={() => setEditorPhoto('')}
                      >
                        Убрать
                      </button>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      JPG, PNG или WebP с этого устройства.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => setItemEditor(null)}
              >
                Отмена
              </Button>
              <Button
                type="submit"
                className="bg-[#171b18] text-white hover:bg-[#2a302b]"
                disabled={saving}
              >
                {itemEditor?.mode === 'edit' ? <Pencil /> : <PackagePlus />}
                {itemEditor?.mode === 'edit'
                  ? 'Сохранить изменения'
                  : 'Добавить позицию'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(refillItem || pendingRefill)}
        onOpenChange={(open) => {
          if (!open && !saving && !pendingRefill) setRefillItem(null);
        }}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={!saving && !pendingRefill}>
          <form onSubmit={submitRefill}>
            <DialogHeader>
              <DialogTitle className="text-xl">Пополнить остатки</DialogTitle>
              <DialogDescription>
                Поступление добавится в лист «Движения склада», а остаток
                пересчитается автоматически.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-6 grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="warehouse-item">Товар</Label>
                <NativeSelect
                  id="warehouse-item"
                  className="w-full"
                  value={activeRefillItem?.id ?? ''}
                  disabled={saving || Boolean(pendingRefill)}
                  onChange={(event) => {
                    setRefillItem(
                      items.find((item) => item.id === event.target.value) ??
                        null,
                    );
                    setRefillAmount('');
                  }}
                >
                  {pendingRefill && !activeRefillItem && (
                    <NativeSelectOption value="">{pendingRefill.name}</NativeSelectOption>
                  )}
                  {items.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {activeRefillItem && (
                <div className="flex items-center gap-3 rounded-2xl bg-muted/55 p-3">
                  <ProductPhoto
                    item={activeRefillItem}
                    className="size-16 rounded-xl"
                  />
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Сейчас на складе
                    </p>
                    <p className="mt-1 font-semibold">
                      {formatQuantity(activeRefillItem.stock)}{' '}
                      {activeRefillItem.unit}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {activeRefillItem.location}
                    </p>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="refill-amount">
                  Сколько поступило
                  {activeRefillItem ? `, ${activeRefillItem.unit}` : ''}
                </Label>
                <Input
                  id="refill-amount"
                  value={pendingRefill ? String(pendingRefill.quantity) : refillAmount}
                  disabled={saving || Boolean(pendingRefill)}
                  onChange={(event) => setRefillAmount(event.target.value)}
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0"
                  required
                  className="h-11 text-lg font-semibold"
                />
              </div>
            </div>
            {pendingRefill && <output className="mt-4 block text-sm">Пополнение ожидает подтверждения: {pendingRefill.name}, {formatQuantity(pendingRefill.quantity)} {pendingRefill.unit}. Данные сохранены и восстановятся после обновления страницы.</output>}
            {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRefillItem(null)}
                disabled={saving || Boolean(pendingRefill)}
              >
                Отмена
              </Button>
              <Button
                type="submit"
                className="bg-[#171b18] text-white hover:bg-[#2a302b]"
                disabled={saving || (!pendingRefill && (!refillAmount || Number(refillAmount.replace(',', '.')) <= 0))}
              >
                <Plus />
                {saving ? 'Проверяем…' : pendingRefill ? 'Проверить пополнение' : 'Добавить на склад'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
