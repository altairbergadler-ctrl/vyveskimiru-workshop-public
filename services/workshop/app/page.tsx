'use client';

import { FormEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Columns3,
  Download,
  Factory,
  LayoutDashboard,
  LayoutGrid,
  LockKeyhole,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Server,
  Table2,
  Trash2,
  Users,
  WalletCards,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ToolsMenu, ToolsSubmenu } from '@/components/tools-navigation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import ProductionPage, { type ProductionData, type ProductionTask } from '@/components/production-page';
import WarehousePage from '@/components/warehouse-page';
import HomeWidgets from '@/components/home-widgets';
import { financeCommandId, confirmFinanceCommand } from '@/lib/finance-command';

const AnalyticsPage = lazy(() => import('@/components/analytics-live'));

type Transaction = {
  id: string;
  type: 'income' | 'expense';
  date: string;
  category: string;
  description: string;
  amount: number;
  account: string;
  orderNumber: string | null;
  counterparty: string | null;
  comment: string | null;
  source: string;
  createdAt: string;
  updatedAt?: string;
  sheetHash?: string;
};

type SyncStatus = {
  configured: boolean;
  pending: number;
  conflicts: number;
  conflictHistory?: number;
  invalidRows?: number;
  last_success_at?: string;
  last_error?: string;
};

type OrderOption = {
  number: string;
  name: string;
  client: string;
  total: number;
  paid: number;
  debt: number;
  status: string;
};

type ExpenseMode = 'money' | 'warehouse';

type WarehouseLookupItem = {
  price: number;
  id: string;
  sku: string;
  name: string;
  category: string;
  expenseCategory: string;
  unit: string;
  stock: number;
  reserved: number;
  location: string;
};

type DebtorGroup = {
  client: string;
  orders: OrderOption[];
  debt: number;
};

type FinanceDetailType = 'cash' | 'income' | 'expense';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type ActivePage = 'dashboard' | 'production' | 'warehouse' | 'analytics';

const GOOGLE_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/EXAMPLE_PRODUCTION_GOOGLE_SHEET_ID_CHANGE_BEFORE_USE/edit';

const fallbackExpenseCategories = [
  'Материалы: баннер/плёнка',
  'Материалы: композит/ПВХ/акрил',
  'Материалы: электрика, диоды, БП',
  'Материалы: крепёж, профиль',
  'Материалы: неон и комплектующие',
  'Материалы: клеи и химия',
  'Чернила и расходники печати',
  'Материалы: инструмент и производственные расходники',
  'Подряд: печать на стороне',
  'Подряд: монтаж/автовышка',
  'Доставка и логистика',
  'Зарплата производство',
  'Зарплата офис / менеджеры',
  'Налоги и взносы',
  'Аренда цеха / офиса',
  'Коммуналка и электричество',
  'Ремонт и обслуживание техники',
  'Реклама и продвижение',
  'Связь, интернет, ПО',
  'Топливо и транспорт',
  'Хозрасходы',
  'Прочее',
  'Аванс',
  'Прибыль соучередителей',
  'Казна',
];

function isWarehouseExpenseCategory(category: string) {
  const normalized = category.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  return normalized.startsWith('материалы:') ||
    normalized === 'чернила и расходники печати' ||
    normalized === 'ремонт и обслуживание техники';
}

function isMaterialExpenseCategory(category: string) {
  const normalized = category.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  return normalized.startsWith('материалы:') || normalized === 'чернила и расходники печати';
}

function normalizeSearchText(value: unknown) {
  const stringValue = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return stringValue
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/([\p{L}])(\d)/gu, '$1 $2')
    .replace(/(\d)([\p{L}])/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesSearch(values: unknown[], query: string) {
  const tokens = normalizeSearchText(query).split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const haystack = values.map(normalizeSearchText).join(' ');
  return tokens.every((token) => haystack.includes(token));
}

const accounts = ['В кассе', 'Расчётный счёт'];

function money(value: number) {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(value);
}

function pluralRu(value: number, one: string, few: string, many: string) {
  const hundreds = Math.abs(value) % 100;
  const tens = hundreds % 10;
  if (hundreds > 10 && hundreds < 20) return many;
  if (tens === 1) return one;
  if (tens >= 2 && tens <= 4) return few;
  return many;
}

function previousMonthKey(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(monthKey: string) {
  const label = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${monthKey}-01T12:00:00`));
  return `${label.charAt(0).toLocaleUpperCase('ru-RU')}${label.slice(1)}`;
}

function automaticPaymentType(order: OrderOption | undefined, amount: number, editing?: Transaction | null) {
  if (!order || order.total <= 0) return editing?.category || 'Оплата по заказу';
  const paidBefore = Math.max(
    order.paid - (editing?.orderNumber === order.number ? editing.amount : 0),
    0,
  );
  if (paidBefore + amount > order.total) return 'Переплата';
  if (paidBefore === 0) return amount >= order.total ? 'Полная оплата' : 'Предоплата';
  return 'Доплата';
}

function orderBalanceHint(order: OrderOption) {
  if (order.total <= 0) return '';
  return order.debt < 0 ? ` · переплата ${money(-order.debt)}` : ` · текущий долг ${money(order.debt)}`;
}


function longDate(date: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
    .format(new Date(`${date}T12:00:00`));
}

export default function Home() {
  const [accessState, setAccessState] = useState<'checking' | 'locked' | 'unlocked'>('checking');
  const [pin, setPin] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transactionsLoaded, setTransactionsLoaded] = useState(false);
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState('');
  const [activePage, setActivePage] = useState<ActivePage>('dashboard');
  const [productionData, setProductionData] = useState<ProductionData | null>(null);
  const [productionLoading, setProductionLoading] = useState(true);
  const [productionError, setProductionError] = useState('');
  const [updatingProductionRow, setUpdatingProductionRow] = useState<number | null>(null);
  const [dialogType, setDialogType] = useState<'income' | 'expense' | null>(null);
  const [debtDetailsOpen, setDebtDetailsOpen] = useState(false);
  const [financeDetailsType, setFinanceDetailsType] = useState<FinanceDetailType | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [financeUpdatedAt, setFinanceUpdatedAt] = useState('');
  const [widgetRevision, setWidgetRevision] = useState(0);
  const [productionQuery, setProductionQuery] = useState('');
  const [warehouseTarget, setWarehouseTarget] = useState<{ sku?: string; refill?: boolean }>({});
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [duplicateReview, setDuplicateReview] = useState<{
    signature: string; confirmation: string; total: number;
    matches: Pick<Transaction, 'id' | 'date' | 'amount' | 'category' | 'description' | 'account' | 'orderNumber' | 'counterparty' | 'comment'>[];
  } | null>(null);
  const duplicateReviewRef = useRef<HTMLDivElement>(null);
  const financeSaving = useRef(false);
  useEffect(() => { duplicateReviewRef.current?.focus(); }, [duplicateReview]);
  const [savedNotice, setSavedNotice] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [incomeMode, setIncomeMode] = useState<'order' | 'measurement'>('order');
  const [incomeOrderNumber, setIncomeOrderNumber] = useState('');
  const [submittedIncomeOrder, setSubmittedIncomeOrder] = useState<OrderOption | null>(null);
  const [incomeAmount, setIncomeAmount] = useState('');
  const [expenseCategories, setExpenseCategories] = useState(fallbackExpenseCategories);
  const [expenseMode, setExpenseMode] = useState<ExpenseMode>('money');
  const [expenseCategory, setExpenseCategory] = useState('');
  const [expenseCategoryQuery, setExpenseCategoryQuery] = useState('');
  const [warehouseItems, setWarehouseItems] = useState<WarehouseLookupItem[]>([]);
  const [warehouseLoaded, setWarehouseLoaded] = useState(false);
  const [warehouseLoading, setWarehouseLoading] = useState(false);
  const [warehouseError, setWarehouseError] = useState('');
  const [warehouseQuery, setWarehouseQuery] = useState('');
  const [selectedWarehouseItem, setSelectedWarehouseItem] = useState<WarehouseLookupItem | null>(null);
  const [warehouseOrderNumber, setWarehouseOrderNumber] = useState('');
  const [warehouseQuantity, setWarehouseQuantity] = useState('');

  const resolvedExpenseCategories = useMemo(() => {
    const current = editingTransaction?.type === 'expense' ? editingTransaction.category : '';
    return current && !expenseCategories.includes(current) ? [current, ...expenseCategories] : expenseCategories;
  }, [editingTransaction, expenseCategories]);

  const warehouseExpenseCategories = useMemo(
    () => resolvedExpenseCategories.filter(isWarehouseExpenseCategory),
    [resolvedExpenseCategories],
  );

  const moneyExpenseCategories = useMemo(() => {
    const current = editingTransaction?.type === 'expense' ? editingTransaction.category : '';
    const categories = resolvedExpenseCategories.filter((category) => !isMaterialExpenseCategory(category));
    return current && !categories.includes(current) ? [current, ...categories] : categories;
  }, [editingTransaction, resolvedExpenseCategories]);

  const orderOptions = useMemo(() => {
    const available = orders.filter(order =>
      (order.debt > 0 && !['отменён', 'отменен'].includes(order.status?.trim().toLocaleLowerCase('ru-RU'))) ||
      order.number === editingTransaction?.orderNumber);
    // Retain the submitted form's order and derived fields while checking its result.
    // A background refresh may already show the just-submitted final payment.
    if (!submittedIncomeOrder) return available;
    return [...available.filter(order => order.number !== submittedIncomeOrder.number), submittedIncomeOrder]
      .sort((a, b) => a.number.localeCompare(b.number, 'ru-RU', { numeric: true }));
  }, [orders, editingTransaction, submittedIncomeOrder]);

  const selectedWarehouseAvailable = selectedWarehouseItem
    ? Math.round(Math.max(selectedWarehouseItem.stock - selectedWarehouseItem.reserved, 0) * 100) / 100
    : 0;
  const warehouseQuantityInput = Number(warehouseQuantity.replace(',', '.'));
  const warehouseQuantityNumber = Number.isFinite(warehouseQuantityInput)
    ? Math.round(warehouseQuantityInput * 100) / 100
    : Number.NaN;
  const warehouseOrderIsValid = !warehouseOrderNumber || Boolean(
    ordersLoaded &&
    !ordersLoading &&
    !ordersError &&
    orders.some((order) => order.number === warehouseOrderNumber),
  );
  const warehouseRemaining = selectedWarehouseItem && Number.isFinite(warehouseQuantityNumber) && warehouseQuantityNumber > 0
    ? Math.round((selectedWarehouseAvailable - warehouseQuantityNumber) * 100) / 100
    : null;
  const warehouseExpenseAmount = selectedWarehouseItem && Number.isFinite(warehouseQuantityNumber) && warehouseQuantityNumber > 0
    ? Math.round(Math.round(selectedWarehouseItem.price * warehouseQuantityNumber * 100) / 100)
    : null;
  const warehouseCanSubmit = Boolean(
    selectedWarehouseItem &&
    warehouseOrderIsValid &&
    Number.isFinite(warehouseQuantityNumber) &&
    warehouseQuantityNumber > 0 &&
    warehouseExpenseAmount !== null && warehouseExpenseAmount > 0 &&
    warehouseQuantityNumber <= selectedWarehouseAvailable,
  );

  const debtorGroups = useMemo(() => {
    const groups = new Map<string, DebtorGroup>();
    for (const order of orders.filter((item) => item.debt > 0)) {
      const client = order.client || 'Клиент не указан';
      const group = groups.get(client) ?? { client, orders: [], debt: 0 };
      group.orders.push(order);
      group.debt += order.debt;
      groups.set(client, group);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        orders: group.orders.sort((a, b) => b.debt - a.debt),
      }))
      .sort((a, b) => b.debt - a.debt || a.client.localeCompare(b.client, 'ru-RU'));
  }, [orders]);

  const selectedIncomeOrder = useMemo(
    () => orderOptions.find((order) => order.number === incomeOrderNumber),
    [incomeOrderNumber, orderOptions],
  );

  const incomeDebtAfter = useMemo(() => {
    if (incomeMode === 'measurement' || !selectedIncomeOrder || !incomeAmount || selectedIncomeOrder.total <= 0) return null;
    const amount = Math.round(Number(incomeAmount));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const debtBefore = selectedIncomeOrder.debt +
      (editingTransaction?.orderNumber === selectedIncomeOrder.number ? editingTransaction.amount : 0);
    return debtBefore - amount;
  }, [editingTransaction, incomeAmount, incomeMode, selectedIncomeOrder]);

  async function loadTransactions() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/transactions', { cache: 'no-store', signal: AbortSignal.timeout(45_000) });
      const data = await response.json() as { transactions?: Transaction[]; error?: string };
      if (!response.ok || !data.transactions) throw new Error(data.error || 'Не удалось загрузить операции');
      setTransactions(data.transactions);
      setFinanceUpdatedAt(new Date().toISOString());
      setTransactionsLoaded(true);
      const syncResponse = await fetch('/api/sync', { cache: 'no-store', signal: AbortSignal.timeout(45_000) });
      if (syncResponse.ok) setSyncStatus(await syncResponse.json() as SyncStatus);
    } catch (loadError) {
      setError(loadError instanceof Error && loadError.name === 'TimeoutError' ? 'Загрузка операций заняла слишком много времени. Повторите попытку.' : loadError instanceof Error ? loadError.message : 'Не удалось загрузить операции');
    } finally {
      setLoading(false);
    }
  }

  async function loadProduction(silent = false) {
    if (!silent) setProductionLoading(true);
    setProductionError('');
    try {
      const response = await fetch('/api/production', { cache: 'no-store', signal: AbortSignal.timeout(45_000) });
      const data = await response.json() as ProductionData & { error?: string };
      if (!response.ok || !Array.isArray(data.tasks)) throw new Error(data.error || 'Не удалось загрузить производство');
      setProductionData(data);
    } catch (loadError) {
      setProductionError(loadError instanceof Error && loadError.name === 'TimeoutError' ? 'Загрузка производства заняла слишком много времени. Повторите попытку.' : loadError instanceof Error ? loadError.message : 'Не удалось загрузить производство');
    } finally {
      if (!silent) setProductionLoading(false);
    }
  }

  async function loadOrders() {
    setOrdersLoading(true);
    setOrdersError('');
    try {
      const response = await fetch('/api/orders', { cache: 'no-store' });
      const data = await response.json() as { orders?: OrderOption[]; error?: string };
      if (!response.ok || !Array.isArray(data.orders)) {
        throw new Error('Не удалось загрузить заказы из Google Таблицы');
      }
      setOrders(data.orders);
      setOrdersLoaded(true);
    } catch (loadError) {
      // Only the orders sheet can establish whether a new payment is allowed.
      setOrdersError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить заказы');
    } finally {
      setOrdersLoading(false);
    }
  }

  async function loadExpenseCategories() {
    try {
      const response = await fetch('/api/expense-categories', { cache: 'no-store' });
      const data = await response.json() as { categories?: string[] };
      if (response.ok && data.categories?.length) setExpenseCategories(data.categories);
    } catch {
      // Keep the complete local list available if Google Sheets is offline.
    }
  }

  async function loadWarehouseItems(force = false) {
    if (warehouseLoading || (warehouseLoaded && !force)) return;
    setWarehouseLoading(true);
    setWarehouseError('');
    try {
      const response = await fetch('/api/warehouse', { cache: 'no-store' });
      const data = await response.json() as { items?: WarehouseLookupItem[]; error?: string };
      if (!response.ok || !Array.isArray(data.items)) {
        throw new Error(data.error || 'Не удалось загрузить материалы со склада');
      }
      setWarehouseItems(data.items);
      setWarehouseLoaded(true);
    } catch (loadError) {
      setWarehouseError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить материалы со склада');
    } finally {
      setWarehouseLoading(false);
    }
  }

  function chooseExpenseMode(mode: ExpenseMode) {
    setDuplicateReview(null);
    setExpenseMode(mode);
    setFormError('');
    if (mode !== 'warehouse') return;
    void loadWarehouseItems();
    if (!ordersLoaded && !ordersLoading) void loadOrders();
  }

  function navigateToPage(page: ActivePage, section?: 'operations' | 'cashflow') {
    if (page === 'production') { window.location.assign('/production/'); return; }
    setActivePage(page);
    if (page === 'warehouse') void loadExpenseCategories();
    const hash = page === 'dashboard' ? (section ? `#${section}` : '#dashboard') : `#${page}`;
    const url = new URL(window.location.href);
    url.searchParams.delete('action');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${hash}`);
    window.requestAnimationFrame(() => {
      if (section) document.getElementById(section)?.scrollIntoView({ behavior: 'smooth' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  useEffect(() => {
    void fetch('/api/session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { authenticated?: boolean }) => setAccessState(data.authenticated ? 'unlocked' : 'locked'))
      .catch(() => setAccessState('locked'));
  }, []);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setIsInstalled(standalone);

    const rememberPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const markInstalled = () => {
      setInstallPrompt(null);
      setIsInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', rememberPrompt);
    window.addEventListener('appinstalled', markInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', rememberPrompt);
      window.removeEventListener('appinstalled', markInstalled);
    };
  }, []);

  useEffect(() => {
    if (accessState !== 'unlocked') return;
    void loadTransactions();
    void loadOrders();
    void loadProduction();
    void loadExpenseCategories();
  }, [accessState]);

  useEffect(() => {
    if (accessState !== 'unlocked' || updatingProductionRow !== null) return;
    const refreshProduction = () => {
      if (document.visibilityState === 'visible') void loadProduction(true);
    };
    const timer = window.setInterval(refreshProduction, 30_000);
    window.addEventListener('focus', refreshProduction);
    document.addEventListener('visibilitychange', refreshProduction);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshProduction);
      document.removeEventListener('visibilitychange', refreshProduction);
    };
  }, [accessState, updatingProductionRow]);

  useEffect(() => {
    const syncPage = () => {
      const hash = window.location.hash;
      setActivePage(hash === '#production' ? 'production' : hash === '#warehouse' ? 'warehouse' : hash === '#analytics' ? 'analytics' : 'dashboard');
    };
    syncPage();
    window.addEventListener('hashchange', syncPage);
    return () => window.removeEventListener('hashchange', syncPage);
  }, []);

  useEffect(() => {
    if (accessState !== 'unlocked') return;
    const url = new URL(window.location.href);
    const action = url.searchParams.get('action');
    if (action === 'production') {
      navigateToPage('production');
    } else if (action === 'income' || action === 'expense') {
      openDialog(action);
      url.searchParams.delete('action');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [accessState]);

  useEffect(() => {
    if (!savedNotice) return;
    const timer = window.setTimeout(() => setSavedNotice(''), 3500);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  const activeMonth = currentMonthKey();

  const monthLabel = useMemo(() => formatMonthLabel(activeMonth), [activeMonth]);

  const periodTransactions = useMemo(
    () => transactions.filter((item) => item.date.startsWith(activeMonth)),
    [activeMonth, transactions],
  );

  const previousMonth = useMemo(() => previousMonthKey(activeMonth), [activeMonth]);
  const previousMonthLabel = useMemo(() => formatMonthLabel(previousMonth), [previousMonth]);
  const previousPeriodTransactions = useMemo(
    () => transactions.filter((item) => item.date.startsWith(previousMonth)),
    [previousMonth, transactions],
  );

  const metrics = useMemo(() => {
    const income = periodTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
    const expense = periodTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
    const previousIncome = previousPeriodTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
    const previousExpense = previousPeriodTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0);
    const cashIncome = transactions.filter((item) => item.type === 'income' && item.account === 'В кассе').reduce((sum, item) => sum + item.amount, 0);
    const cashExpense = transactions.filter((item) => item.type === 'expense' && item.account === 'В кассе').reduce((sum, item) => sum + item.amount, 0);
    const debts = orders.filter((order) => order.debt > 0);
    return {
      income,
      expense,
      previousIncome,
      previousExpense,
      cashIncome,
      cashExpense,
      cashBalance: cashIncome - cashExpense,
      debt: debts.reduce((sum, order) => sum + order.debt, 0),
      debtOrderCount: debts.length,
    };
  }, [orders, periodTransactions, previousPeriodTransactions, transactions]);

  const financeDetails = useMemo(() => {
    if (!financeDetailsType) return null;
    if (financeDetailsType === 'cash') {
      return {
        type: financeDetailsType,
        title: 'Денег в кассе',
        description: 'Все поступления и расходы, которые формируют текущий остаток.',
        totalLabel: 'Текущий остаток',
        periodLabel: 'С начала учёта',
        total: metrics.cashBalance,
        firstStatLabel: 'Поступило',
        firstStatValue: money(metrics.cashIncome),
        secondStatLabel: 'Потрачено',
        secondStatValue: money(metrics.cashExpense),
        emptyTitle: 'В кассе пока нет операций',
        emptyDescription: 'Остаток появится после первого поступления или расхода.',
        transactions: transactions.filter((item) =>
          item.account === 'В кассе'),
      };
    }

    const isIncome = financeDetailsType === 'income';
    const detailTransactions = periodTransactions.filter((item) => item.type === financeDetailsType);
    return {
      type: financeDetailsType,
      title: isIncome ? 'Доходы за месяц' : 'Расходы за месяц',
      description: isIncome
        ? 'Поступления за текущий месяц с заказами и клиентами.'
        : 'Расходы за текущий месяц с категориями и получателями.',
      totalLabel: isIncome ? 'Доходы' : 'Расходы',
      periodLabel: monthLabel,
      total: isIncome ? metrics.income : metrics.expense,
      firstStatLabel: 'Операций',
      firstStatValue: String(detailTransactions.length),
      secondStatLabel: 'Прошлый месяц',
      secondStatValue: money(isIncome ? metrics.previousIncome : metrics.previousExpense),
      emptyTitle: isIncome ? 'Доходов за месяц нет' : 'Расходов за месяц нет',
      emptyDescription: `За ${monthLabel.toLocaleLowerCase('ru-RU')} операций этого типа не найдено.`,
      transactions: detailTransactions,
    };
  }, [financeDetailsType, metrics, monthLabel, periodTransactions, transactions]);

  const ordersUnavailable = ordersLoading || !ordersLoaded || Boolean(ordersError);
  const productionUnavailable = productionLoading || Boolean(productionError);

  const visibleTransactions = useMemo(
    () => transactions.filter((item) => {
      if (filter !== 'all' && item.type !== filter) return false;
      if (accountFilter !== 'all' && item.account !== accountFilter) return false;
      if (dateFrom && item.date < dateFrom) return false;
      if (dateTo && item.date > dateTo) return false;
      const query = search.trim().toLocaleLowerCase('ru-RU');
      if (!query) return true;
      return [item.description, item.category, item.counterparty, item.orderNumber, item.comment]
        .some((value) => value?.toLocaleLowerCase('ru-RU').includes(query));
    }),
    [accountFilter, dateFrom, dateTo, filter, search, transactions],
  );

  const visibleTotals = useMemo(() => ({
    income: visibleTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + item.amount, 0),
    expense: visibleTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0),
  }), [visibleTransactions]);

  async function toggleProductionTask(task: ProductionTask, completed: boolean) {
    setUpdatingProductionRow(task.row);
    setProductionError('');
    try {
      const response = await fetch('/api/production', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row: task.row, key: task.key, completed }),
      });
      const data = await response.json() as ProductionData & { error?: string };
      if (!response.ok || !Array.isArray(data.tasks)) throw new Error(data.error || 'Не удалось обновить задачу');
      setProductionData(data);
      setSavedNotice(`Сохранено в Google Таблице · выполнено сегодня: ${data.stats.completedToday}`);
      setWidgetRevision(current => current + 1);
    } catch (updateError) {
      setProductionError(updateError instanceof Error ? updateError.message : 'Не удалось обновить задачу');
    } finally {
      setUpdatingProductionRow(null);
    }
  }

  async function submitWarehouseIssue(form: HTMLFormElement) {
    if (!selectedWarehouseItem) {
      setFormError('Выберите материал со склада');
      return;
    }
    if (!warehouseOrderIsValid) {
      setFormError(ordersError || 'Обновите список заказов и выберите заказ заново');
      return;
    }
    if (!Number.isFinite(warehouseQuantityNumber) || warehouseQuantityNumber <= 0) {
      setFormError('Укажите количество материала');
      return;
    }
    if (warehouseQuantityNumber > selectedWarehouseAvailable) {
      setFormError(`Доступно только ${selectedWarehouseAvailable.toLocaleString('ru-RU')} ${selectedWarehouseItem.unit}`);
      return;
    }

    const values = new FormData(form);
    const issuePayload = {
      code: selectedWarehouseItem.sku,
      quantity: warehouseQuantityNumber,
      orderNumber: warehouseOrderNumber,
      comment: String(values.get('comment') ?? '').trim(),
    };
    financeSaving.current = true;
    setSaving(true);
    setFormError('');
    try {
      const response = await fetch('/api/warehouse/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...issuePayload, requestId: financeCommandId('warehouse-expense', issuePayload) }),
      });
      const data = await response.json() as { items?: WarehouseLookupItem[]; transaction?: Transaction; error?: string };
      if (!response.ok || !data.transaction) throw new Error(data.error || 'Не удалось подтвердить списание и расход');
      confirmFinanceCommand('warehouse-expense');
      setTransactions(current => [data.transaction!, ...current.filter(item => item.id !== data.transaction!.id)]
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));
      setFinanceUpdatedAt(new Date().toISOString());
      if (Array.isArray(data.items)) setWarehouseItems(data.items);
      setWarehouseLoaded(true);
      setWidgetRevision(current => current + 1);
      setSavedNotice(
        `${selectedWarehouseItem.name}: списано ${warehouseQuantityNumber.toLocaleString('ru-RU')} ${selectedWarehouseItem.unit}${warehouseOrderNumber ? ` на заказ №${warehouseOrderNumber}` : ''} · расход из кассы ${money(data.transaction.amount)}`,
      );
      setDialogType(null);
      setEditingTransaction(null);
      resetExpenseDraft();
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : 'Не удалось списать материал');
    } finally {
      financeSaving.current = false;
      setSaving(false);
    }
  }

  async function submitTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialogType || financeSaving.current) return;
    if (dialogType === 'expense' && !editingTransaction && expenseMode === 'warehouse') {
      await submitWarehouseIssue(event.currentTarget);
      return;
    }

    const values = new FormData(event.currentTarget);
    const amount = Math.round(Number(values.get('amount')));
    const orderNumber = dialogType === 'income'
      ? String(values.get('orderNumber') ?? '').trim()
      : (editingTransaction?.orderNumber ?? '');
    const selectedOrder = orderOptions.find((order) => order.number === orderNumber);
    const measurement = dialogType === 'income' && incomeMode === 'measurement';
    if (dialogType === 'income' && !measurement && !selectedOrder && editingTransaction?.orderNumber !== orderNumber) {
      setFormError('Обновите список и выберите доступный для оплаты заказ');
      return;
    }
    const category = dialogType === 'income'
      ? (measurement ? 'Замеры' : automaticPaymentType(selectedOrder, amount, editingTransaction))
      : expenseCategory;
    if (dialogType === 'expense' && !category) {
      setFormError('Выберите статью расхода из списка');
      return;
    }
    setFormError('');
    const counterparty = measurement ? null : dialogType === 'income'
      ? selectedOrder?.client ||
        (editingTransaction?.orderNumber === orderNumber ? editingTransaction.counterparty : null)
      : String(values.get('counterparty') ?? '').trim();
    const enteredDescription = String(values.get('description') ?? '').trim();
    const description = measurement ? 'Замеры' : dialogType === 'income'
      ? `${category} · ${counterparty || `заказ №${orderNumber}`}`
      : enteredDescription;
    const payload = {
      id: editingTransaction?.id,
      expectedHash: editingTransaction?.sheetHash,
      type: dialogType,
      date: values.get('date'),
      amount,
      category,
      description,
      account: values.get('account'),
      orderNumber,
      counterparty,
      comment: values.get('comment'),
    };
    const signature = JSON.stringify(payload);
    const confirming = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('name') === 'confirm-duplicate';
    const duplicateConfirmation = confirming && duplicateReview?.signature === signature
      ? duplicateReview.confirmation : undefined;
    financeSaving.current = true;
    setSaving(true);
    if (dialogType === 'income' && !measurement && selectedOrder) setSubmittedIncomeOrder(selectedOrder);
    try {
      const response = await fetch('/api/transactions', {
        method: editingTransaction ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId: financeCommandId('save', payload), duplicateConfirmation }),
      });
      const data = await response.json() as { transaction?: Transaction; error?: string; syncPending?: boolean;
        code?: string; duplicateWarning?: Omit<NonNullable<typeof duplicateReview>, 'signature'> };
      if (data.code === 'FINANCE_POSSIBLE_DUPLICATE' && data.duplicateWarning) {
        setDuplicateReview({ ...data.duplicateWarning, signature });
        return;
      }
      if (!response.ok || !data.transaction) {
        if (response.status < 500 && !['FINANCE_UNCONFIRMED', 'FINANCE_PENDING'].includes(data.code ?? '')) setSubmittedIncomeOrder(null);
        throw new Error(data.error || 'Не удалось сохранить операцию');
      }
      setDuplicateReview(null);
      setSubmittedIncomeOrder(null);
      confirmFinanceCommand('save');
      setWidgetRevision(current => current + 1);
      setFinanceUpdatedAt(new Date().toISOString());
      setTransactions((current) => {
        const next = editingTransaction
          ? current.map((item) => item.id === data.transaction!.id ? data.transaction! : item)
          : [data.transaction!, ...current.filter(item => item.id !== data.transaction!.id)];
        return next.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
      });
      if (dialogType === 'income' && !measurement) await loadOrders();
      setSavedNotice(editingTransaction ? 'Операция обновлена' : dialogType === 'income' ? 'Доход сохранён' : 'Расход сохранён');
      if (data.syncPending) setSyncStatus((current) => current ? { ...current, pending: current.pending + 1 } : current);
      setDialogType(null);
      setEditingTransaction(null);
      resetExpenseDraft();
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : 'Не удалось сохранить операцию');
    } finally {
      financeSaving.current = false;
      setSaving(false);
    }
  }

  function resetExpenseDraft() {
    setExpenseMode('money');
    setExpenseCategory('');
    setExpenseCategoryQuery('');
    setWarehouseQuery('');
    setSelectedWarehouseItem(null);
    setWarehouseOrderNumber('');
    setWarehouseQuantity('');
    setWarehouseError('');
  }

  function openDialog(type: 'income' | 'expense') {
    setDuplicateReview(null);
    setSubmittedIncomeOrder(null);
    setFormError('');
    setEditingTransaction(null);
    setIncomeMode('order');
    setIncomeOrderNumber('');
    setIncomeAmount('');
    resetExpenseDraft();
    if (type === 'expense') setWarehouseLoaded(false);
    if (type === 'income') void loadOrders();
    if (type === 'expense') void loadExpenseCategories();
    setDialogType(type);
  }

  function editTransaction(transaction: Transaction) {
    setDuplicateReview(null);
    setSubmittedIncomeOrder(null);
    setFormError('');
    resetExpenseDraft();
    setEditingTransaction(transaction);
    setIncomeMode(transaction.type === 'income' && transaction.category === 'Замеры' ? 'measurement' : 'order');
    setIncomeOrderNumber(transaction.orderNumber ?? '');
    setIncomeAmount(String(transaction.amount));
    if (transaction.type === 'expense') {
      setExpenseCategory(transaction.category);
      setExpenseCategoryQuery(transaction.category);
    }
    setDialogType(transaction.type);
  }

  function closeDialog() {
    if (saving) return;
    setDuplicateReview(null);
    setSubmittedIncomeOrder(null);
    setDialogType(null);
    setEditingTransaction(null);
    setIncomeOrderNumber('');
    setIncomeAmount('');
    resetExpenseDraft();
  }

  async function deleteSelectedTransaction() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch('/api/transactions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id, expectedHash: deleteTarget.sheetHash,
          requestId: financeCommandId('delete', { id: deleteTarget.id, expectedHash: deleteTarget.sheetHash }) }),
      });
      const data = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !data.success) throw new Error(data.error || 'Не удалось удалить операцию');
      confirmFinanceCommand('delete');
      setWidgetRevision(current => current + 1);
      setFinanceUpdatedAt(new Date().toISOString());
      setTransactions((current) => current.filter((item) => item.id !== deleteTarget.id));
      if (deleteTarget.type === 'income') await loadOrders();
      setSavedNotice('Операция удалена');
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить операцию');
    } finally {
      setDeleting(false);
    }
  }

  function resetFilters() {
    setFilter('all');
    setAccountFilter('all');
    setSearch('');
    setDateFrom('');
    setDateTo('');
  }

  function exportOperations() {
    const escapeCell = (value: string | number | null) => {
      let text = String(value ?? '');
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
      ['Дата', 'Тип', 'Категория', 'Описание', 'Сумма', 'Касса / счёт', '№ заказа', 'Контрагент', 'Комментарий'],
      ...visibleTransactions.map((item) => [item.date, item.type === 'income' ? 'Доход' : 'Расход', item.category, item.description, item.amount, item.account, item.orderNumber, item.counterparty, item.comment]),
    ];
    const blob = new Blob([`\uFEFF${rows.map((row) => row.map(escapeCell).join(';')).join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `operations-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function unlockDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setUnlockError('');
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await response.json() as { authenticated?: boolean; error?: string };
      if (!response.ok || !data.authenticated) throw new Error(data.error || 'Не удалось войти');
      setPin('');
      setAccessState('unlocked');
    } catch (loginError) {
      setUnlockError(loginError instanceof Error ? loginError.message : 'Не удалось войти');
      setPin('');
    } finally {
      setSaving(false);
    }
  }

  async function lockDevice() {
    await fetch('/api/session', { method: 'DELETE' }).catch(() => undefined);
    setDialogType(null);
    setEditingTransaction(null);
    setDeleteTarget(null);
    setTransactions([]);
    setTransactionsLoaded(false);
    setOrders([]);
    setOrdersLoaded(false);
    setOrdersError('');
    setProductionData(null);
    setProductionError('');
    setLoading(true);
    setProductionLoading(true);
    setActivePage('dashboard');
    setPin('');
    setAccessState('locked');
  }

  async function installApplication() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (choice.outcome === 'accepted') setSavedNotice('Приложение устанавливается');
  }

  if (accessState !== 'unlocked') {
    return (
      <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#171b18] px-4 py-10 text-white">
        <div className="pointer-events-none absolute -left-24 top-[-8rem] size-80 rounded-full bg-[#b5f23c]/12 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-36 right-[-7rem] size-96 rounded-full bg-[#b5f23c]/10 blur-3xl" />
        <section className="relative w-full max-w-sm rounded-[28px] border border-white/10 bg-white/[0.07] p-6 shadow-2xl backdrop-blur-xl sm:p-8" aria-labelledby="access-title">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#b5f23c] text-[#171b18] shadow-[0_12px_36px_rgba(181,242,60,.22)]">
            <LockKeyhole className="size-6" />
          </div>
          <div className="mt-6 text-center">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/45">Финансы</p>
            <h1 id="access-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Доступ к приложению</h1>
            <p className="mt-2 text-sm leading-6 text-white/55">Введите PIN. После входа это устройство останется авторизованным.</p>
          </div>

          {accessState === 'checking' ? (
            <div className="mt-8 flex items-center justify-center gap-2 text-sm text-white/55">
              <RefreshCw className="size-4 animate-spin" /> Проверяем устройство…
            </div>
          ) : (
            <form className="mt-8" onSubmit={unlockDevice}>
              <Label htmlFor="access-pin" className="text-white/72">PIN-код</Label>
              <Input
                id="access-pin"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                maxLength={4}
                value={pin}
                onChange={(event) => {
                  setPin(event.target.value.replace(/\D/g, '').slice(0, 4));
                  if (unlockError) setUnlockError('');
                }}
                autoFocus
                required
                aria-invalid={Boolean(unlockError)}
                className="mt-2 h-12 border-white/15 bg-white/[0.08] text-center text-xl tracking-[0.45em] text-white placeholder:text-white/25 focus-visible:border-[#b5f23c]/65 focus-visible:ring-[#b5f23c]/20"
                placeholder="••••"
              />
              {unlockError && <p className="mt-3 text-center text-sm text-[#ff9a86]" role="alert">{unlockError}</p>}
              <Button type="submit" className="mt-5 h-11 w-full bg-[#b5f23c] text-[#171b18] hover:bg-[#c5fb59]" disabled={pin.length !== 4 || saving}>
                {saving ? 'Проверяем…' : 'Открыть приложение'}
              </Button>
            </form>
          )}

          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-white/38">
            <WalletCards className="size-3.5" /> Наружная реклама
          </div>
          {!isInstalled && installPrompt && (
            <Button type="button" variant="ghost" className="mt-4 w-full text-white/65 hover:bg-white/8 hover:text-white" onClick={() => void installApplication()}>
              <Download />Установить на рабочий стол
            </Button>
          )}
          <Button type="button" variant="ghost" className="mt-2 w-full text-white/65 hover:bg-white/8 hover:text-white" nativeButton={false} render={<a href="/downloads/finance-widget-1.1.0.apk" download />}>
            <LayoutGrid />Android-виджет
          </Button>
        </section>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/90 backdrop-blur-xl lg:hidden">
        <div className="flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">{activePage === 'analytics' ? <BarChart3 className="size-5" /> : activePage === 'production' ? <Factory className="size-5" /> : activePage === 'warehouse' ? <Boxes className="size-5" /> : <WalletCards className="size-5" />}</div>
            <div><p className="text-sm font-semibold leading-none">{activePage === 'analytics' ? 'Аналитика' : activePage === 'production' ? 'Производство' : activePage === 'warehouse' ? 'Склад' : 'Финансы'}</p><p className="mt-1 text-[11px] text-muted-foreground">Наружная реклама</p></div>
          </div>
          <div className="flex items-center">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9"
                    aria-label="Меню и ссылки"
                  />
                }
              >
                <LayoutGrid />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)] p-2">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="px-2 py-1.5">Разделы</DropdownMenuLabel>
                  <DropdownMenuItem className="gap-3 px-2 py-2.5" onClick={() => navigateToPage('dashboard')}><LayoutDashboard />Дашборд</DropdownMenuItem>
                  <DropdownMenuItem className="gap-3 px-2 py-2.5" onClick={() => navigateToPage('analytics')}><BarChart3 />Аналитика</DropdownMenuItem>
                  <DropdownMenuItem className="gap-3 px-2 py-2.5" onClick={() => navigateToPage('production')}><Factory />Производство</DropdownMenuItem>
                  <DropdownMenuItem className="gap-3 px-2 py-2.5" onClick={() => navigateToPage('warehouse')}><Boxes />Склад</DropdownMenuItem>
                  <DropdownMenuItem className="gap-3 px-2 py-2.5" render={<a href="/kanban/" />}><Columns3 />Заказы</DropdownMenuItem>
                  <ToolsSubmenu />
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="px-2 py-1.5">Приложение</DropdownMenuLabel>
                  <DropdownMenuItem
                    className="gap-3 px-2 py-2.5"
                    disabled={isInstalled || !installPrompt}
                    onClick={() => void installApplication()}
                  >
                    <Download />
                    {isInstalled
                      ? 'Приложение уже установлено'
                      : installPrompt
                        ? 'Установить приложение'
                        : 'Установка — через меню браузера'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-3 px-2 py-2.5"
                    render={<a href="/downloads/finance-widget-1.1.0.apk" download />}
                  >
                    <LayoutGrid />
                    Скачать Android-виджет
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="gap-3 px-2 py-2.5"
                    render={<a href={GOOGLE_SHEET_URL} target="_blank" rel="noreferrer" />}
                  >
                    <Table2 />
                    Открыть Google Таблицу
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-[#171b18] px-5 py-6 text-white lg:flex">
        <div className="flex items-center gap-3 px-2">
          <div className="grid size-10 place-items-center rounded-xl bg-[#b5f23c] text-[#171b18]"><Factory className="size-5" /></div>
          <div><p className="font-semibold leading-none">Мастерская</p><p className="mt-1.5 text-xs text-white/48">Наружная реклама</p></div>
        </div>
        <nav className="mt-12 space-y-1" aria-label="Основная навигация">
          <button type="button" className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${activePage === 'dashboard' ? 'bg-white/10 font-medium' : 'text-white/62 hover:bg-white/5 hover:text-white'}`} onClick={() => navigateToPage('dashboard')}><LayoutDashboard className={`size-[18px] ${activePage === 'dashboard' ? 'text-[#b5f23c]' : ''}`} />Дашборд</button>
          <button type="button" className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${activePage === 'analytics' ? 'bg-white/10 font-medium' : 'text-white/62 hover:bg-white/5 hover:text-white'}`} onClick={() => navigateToPage('analytics')}><BarChart3 className={`size-[18px] ${activePage === 'analytics' ? 'text-[#b5f23c]' : ''}`} />Аналитика</button>
          <button type="button" className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${activePage === 'production' ? 'bg-white/10 font-medium' : 'text-white/62 hover:bg-white/5 hover:text-white'}`} onClick={() => navigateToPage('production')}><Factory className={`size-[18px] ${activePage === 'production' ? 'text-[#b5f23c]' : ''}`} />Производство</button>
          <button type="button" className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition ${activePage === 'warehouse' ? 'bg-white/10 font-medium' : 'text-white/62 hover:bg-white/5 hover:text-white'}`} onClick={() => navigateToPage('warehouse')}><Boxes className={`size-[18px] ${activePage === 'warehouse' ? 'text-[#b5f23c]' : ''}`} />Склад</button>
          <a href="/kanban/" className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm text-white/62 transition hover:bg-white/5 hover:text-white"><Columns3 className="size-[18px]" />Заказы</a>
          <ToolsMenu className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm text-white/62 transition hover:bg-white/5 hover:text-white" />
        </nav>
        <div className="mt-auto rounded-2xl bg-white/[0.06] p-4">
          <div className="mb-3 flex items-center justify-between text-xs text-white/48"><a href="/status.html">Состояние приложения</a><span className={`size-2 rounded-full ${error || syncStatus?.last_error || syncStatus?.invalidRows ? 'bg-[#ef755e]' : syncStatus?.pending ? 'bg-[#f5b94c]' : 'bg-[#b5f23c]'}`} /></div>
          <p className="text-sm font-medium">{monthLabel}</p>
          <p className="mt-1 text-xs text-white/48">{loading ? 'Загрузка…' : `${transactions.length} операций`}</p>
          <div className="mt-3 flex items-center gap-2 border-t border-white/8 pt-3 text-xs text-white/48"><Server className="size-3.5" />{syncStatus?.configured ? (syncStatus.last_error ? 'Не удалось проверить данные' : syncStatus.invalidRows ? `Проблемы в таблице: ${syncStatus.invalidRows}` : syncStatus.pending ? `В очереди: ${syncStatus.pending}` : 'Данные из Google Таблицы') : 'Нет подключения к таблице'}</div>
        </div>
        {!isInstalled && installPrompt && <Button variant="ghost" className="mt-3 justify-start text-white/70 hover:bg-white/5 hover:text-white" onClick={() => void installApplication()}><Download />Установить приложение</Button>}
        <Button variant="ghost" className="mt-1 justify-start text-white/65 hover:bg-white/5 hover:text-white" nativeButton={false} render={<a href="/downloads/finance-widget-1.1.0.apk" download />}><LayoutGrid />Android-виджет</Button>
        <Button variant="ghost" className="mt-1 justify-start text-white/65 hover:bg-white/5 hover:text-white" nativeButton={false} render={<a href={GOOGLE_SHEET_URL} target="_blank" rel="noreferrer" />}><Table2 />Google Таблица</Button>
        <Button variant="ghost" className="mt-3 justify-start text-white/55 hover:bg-white/5 hover:text-white" onClick={() => void lockDevice()}><LockKeyhole />Заблокировать</Button>
      </aside>

      <main className="pb-28 lg:ml-[248px] lg:pb-10" id={activePage}>
        {syncStatus && (syncStatus.last_error || syncStatus.invalidRows || syncStatus.pending) ? (
          <div className="mx-4 mt-4 rounded-2xl border border-[#ef755e]/25 bg-[#fff0ec] px-4 py-3 text-sm text-[#9f3f31] lg:mx-8" role="status">
            {syncStatus.last_error ? 'Не удалось подтвердить данные Google Таблицы.' : syncStatus.invalidRows ? `В Google Таблице найдены неполные строки: ${syncStatus.invalidRows}. Обновление не подтверждено.` : `Операции ожидают записи в Google Таблицу: ${syncStatus.pending}.`}
          </div>
        ) : null}
        {activePage === 'analytics' ? (
          <Suspense fallback={<output className="block p-8 text-sm text-muted-foreground">Загружаем аналитику…</output>}><AnalyticsPage onBack={() => navigateToPage('dashboard')} /></Suspense>
        ) : activePage === 'warehouse' ? (
          <WarehousePage onBack={() => { setWarehouseTarget({}); navigateToPage('dashboard'); }} expenseCategories={warehouseExpenseCategories} initialSku={warehouseTarget.sku} initialRefill={warehouseTarget.refill} />
        ) : activePage === 'production' ? (
          <ProductionPage
            initialSearch={productionQuery}
            data={productionData}
            error={productionError}
            loading={productionLoading}
            updatingRow={updatingProductionRow}
            onBack={() => { setProductionQuery(''); navigateToPage('dashboard'); }}
            onRefresh={() => void loadProduction()}
            onToggle={(task, completed) => void toggleProductionTask(task, completed)}
          />
        ) : (
        <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-7 lg:px-10 lg:py-9">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div><p className="text-sm text-muted-foreground">Финансовая картина</p><h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Добрый день, Виктор</h1></div>
            <div className="hidden gap-2 lg:flex">
              <Button variant="outline" className="h-10 flex-1 px-4 sm:flex-none" onClick={() => openDialog('expense')}><ArrowDownLeft />Расход</Button>
              <Button className="h-10 flex-1 bg-[#171b18] px-4 text-white hover:bg-[#2a312c] sm:flex-none" onClick={() => openDialog('income')}><Plus />Добавить доход</Button>
            </div>
          </div>

          {error && (
            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-[#ef755e]/25 bg-[#fff0ec] p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span>{error}</span><Button variant="outline" size="sm" onClick={() => void loadTransactions()}><RefreshCw />Повторить</Button>
            </div>
          )}

          <section className="mt-5 grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(380px,.95fr)]" aria-label="Сводка">
            <article className="min-w-0 overflow-hidden rounded-[22px] border border-border bg-card" aria-labelledby="finance-summary-title">
              <header className="flex items-center justify-between border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2"><h2 id="finance-summary-title" className="font-semibold">Финансы</h2><p className="text-xs text-muted-foreground">остаток и движение денег</p></div>
                <WalletCards className="size-5 text-[#6d942c]" />
              </header>
              <div className="grid grid-cols-2">
                <button
                  type="button"
                  className="group relative overflow-hidden bg-[#171b18] px-4 py-3 text-left text-white transition-colors hover:bg-[#222923] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#b5f23c] disabled:cursor-default disabled:hover:bg-[#171b18]"
                  onClick={() => setFinanceDetailsType('cash')}
                  disabled={!transactionsLoaded}
                  aria-haspopup="dialog"
                  aria-label="Показать движение денег в кассе"
                >
                  <div className="absolute -right-8 -top-12 size-32 rounded-full bg-[#b5f23c]/10 blur-2xl" />
                  <p className="relative flex items-center justify-between gap-2 text-xs text-white/55 sm:text-sm">
                    <span>Денег в кассе</span>
                    {transactionsLoaded && <ChevronRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />}
                  </p>
                  <p className="mt-1 whitespace-nowrap text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tabular-nums tracking-[-0.04em]">{transactionsLoaded ? money(metrics.cashBalance) : '—'}</p>
                  <p className="mt-1 text-[11px] leading-4 text-white/42">с начала учёта</p>
                </button>
                <button
                  type="button"
                  className="group border-l border-border bg-[#edf8d9] px-4 py-3 text-left transition-colors hover:bg-[#e4f3c8] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6d942c] disabled:cursor-default disabled:hover:bg-[#edf8d9]"
                  onClick={() => setDebtDetailsOpen(true)}
                  disabled={ordersUnavailable}
                  aria-haspopup="dialog"
                  aria-label="Показать детали клиентской задолженности"
                >
                  <p className="flex items-center justify-between gap-2 text-xs text-[#52613b] sm:text-sm">
                    <span>Клиентская задолженность</span>
                    {!ordersUnavailable && <ChevronRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />}
                  </p>
                  <p className="mt-1 whitespace-nowrap text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tabular-nums tracking-[-0.04em] text-[#263017]">{ordersUnavailable ? '—' : money(metrics.debt)}</p>
                  <p className="mt-1 text-[11px] leading-4 text-[#52613b]">{ordersUnavailable ? (ordersError ? 'не удалось обновить' : 'загрузка…') : `${metrics.debtOrderCount} ${pluralRu(metrics.debtOrderCount, 'заказ', 'заказа', 'заказов')}`}</p>
                </button>
                <button
                  type="button"
                  className="group border-t border-border px-4 py-3 text-left transition-colors hover:bg-[#f7fbef] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6d942c] disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => setFinanceDetailsType('income')}
                  disabled={!transactionsLoaded}
                  aria-haspopup="dialog"
                  aria-label="Показать доходы за месяц"
                >
                  <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground sm:text-sm"><span className="flex items-center gap-1"><ArrowDownLeft className="size-3.5 text-[#6d942c]" />Доходы за месяц</span>{transactionsLoaded && <ChevronRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />}</p>
                  <p className="mt-1 whitespace-nowrap text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tabular-nums tracking-[-0.04em]">{transactionsLoaded ? money(metrics.income) : '—'}</p>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{transactionsLoaded ? <>{previousMonthLabel} · {money(metrics.previousIncome)}</> : error ? 'не удалось загрузить' : 'загрузка…'}</p>
                </button>
                <button
                  type="button"
                  className="group border-l border-t border-border px-4 py-3 text-left transition-colors hover:bg-[#fff7f4] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#c35642] disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => setFinanceDetailsType('expense')}
                  disabled={!transactionsLoaded}
                  aria-haspopup="dialog"
                  aria-label="Показать расходы за месяц"
                >
                  <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground sm:text-sm"><span className="flex items-center gap-1"><ArrowUpRight className="size-3.5 text-[#c35642]" />Расходы за месяц</span>{transactionsLoaded && <ChevronRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />}</p>
                  <p className="mt-1 whitespace-nowrap text-[clamp(1.25rem,4vw,1.5rem)] font-semibold tabular-nums tracking-[-0.04em]">{transactionsLoaded ? money(metrics.expense) : '—'}</p>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{transactionsLoaded ? <>{previousMonthLabel} · {money(metrics.previousExpense)}</> : error ? 'не удалось загрузить' : 'загрузка…'}</p>
                </button>
              </div>
            </article>

            <button type="button" className="grid min-w-0 grid-rows-[auto_1fr] overflow-hidden rounded-[22px] border border-border bg-card text-left transition hover:border-[#9bd226]/60 hover:shadow-sm" onClick={() => navigateToPage('production')} aria-label="Открыть производство">
              <span className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="flex flex-wrap items-baseline gap-x-2"><span className="font-semibold">Производство сегодня</span><span className={`text-xs ${productionError ? 'text-[#c35642]' : 'text-muted-foreground'}`}>{productionError ? 'не удалось обновить' : 'открыть задачи и этапы'}</span></span>
                <Factory className="size-5 shrink-0 text-[#6d942c]" />
              </span>
              <span className="grid grid-rows-3 divide-y divide-border">
                <span className="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5">
                  <span><span className="block text-xs text-muted-foreground">План на сегодня</span><span className="mt-0.5 block text-[11px] text-muted-foreground/75">этапов</span></span>
                  <span className="text-2xl font-semibold tabular-nums tracking-[-0.04em]">{productionUnavailable ? '—' : productionData?.stats.planToday ?? '—'}</span>
                </span>
                <span className="flex min-w-0 items-center justify-between gap-3 bg-[#edf8d9] px-4 py-2.5">
                  <span><span className="flex items-center gap-1 text-xs text-[#52613b]"><CheckCircle2 className="size-3.5 shrink-0" />Выполнено сегодня</span><span className="mt-0.5 block text-[11px] text-[#52613b]/75">этапов</span></span>
                  <span className="text-2xl font-semibold tabular-nums tracking-[-0.04em] text-[#263017]">{productionUnavailable ? '—' : productionData?.stats.completedToday ?? '—'}</span>
                </span>
                <span className="flex min-w-0 items-center justify-between gap-3 bg-[#fff7f4] px-4 py-2.5">
                  <span><span className="flex items-center gap-1 text-xs text-[#955242]"><CalendarDays className="size-3.5 shrink-0" />Дедлайн сегодня</span><span className="mt-0.5 block text-[11px] text-[#a56557]">{productionUnavailable ? 'заказов к завершению' : `${pluralRu(productionData?.stats.dueTodayOrders ?? 0, 'заказ', 'заказа', 'заказов')} к завершению`}</span></span>
                  <span className="text-2xl font-semibold tabular-nums tracking-[-0.04em] text-[#743c31]">{productionUnavailable ? '—' : productionData?.stats.dueTodayOrders ?? '—'}</span>
                </span>
              </span>
            </button>
          </section>

          <HomeWidgets
            revision={widgetRevision}
            production={productionData} productionError={productionError} productionLoading={productionLoading} updatingRow={updatingProductionRow}
            transactions={transactions} transactionsLoaded={transactionsLoaded} financeError={error} financeLoading={loading} financeUpdatedAt={financeUpdatedAt}
            onRefreshFinance={() => { void loadTransactions(); void loadOrders(); }} onRefreshProduction={() => void loadProduction()}
            onToggleProduction={(task, completed) => void toggleProductionTask(task, completed)}
            onProduction={(query = '') => { window.location.assign(`/production/${query ? `?search=${encodeURIComponent(query)}` : ''}`); }}
            onWarehouse={(sku, refill) => { setWarehouseTarget({ sku, refill }); navigateToPage('warehouse'); }}
            onIncome={(orderId) => { openDialog('income'); if (orderId && orders.some(order => order.number === orderId && order.debt > 0 && !['отменён', 'отменен'].includes(order.status?.trim().toLocaleLowerCase('ru-RU')))) setIncomeOrderNumber(orderId); }}
            onExpense={(issue) => { openDialog('expense'); if (issue) chooseExpenseMode('warehouse'); }}
            onTransaction={(id) => { const transaction = transactions.find(t => t.id === id); if (transaction) editTransaction(transaction); }}
            onJournal={() => navigateToPage('dashboard', 'operations')}
          />

          <section className="mt-4 scroll-mt-20 rounded-[22px] border border-border bg-card p-5 sm:p-6" id="operations" aria-labelledby="operations-title">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="operations-title" className="font-semibold">Журнал операций</h2>
                <p className="mt-1 text-sm text-muted-foreground">Поиск, фильтры, редактирование и выгрузка</p>
              </div>
              <Button variant="outline" className="h-9" onClick={exportOperations} disabled={visibleTransactions.length === 0}><Download />Скачать CSV</Button>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(220px,1.4fr)_auto_180px_160px_160px_auto]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Клиент, категория, заказ…" className="h-10 pl-9 pr-9" aria-label="Поиск операций" />
                {search && <button type="button" onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Очистить поиск"><X className="size-4" /></button>}
              </div>
              <div className="flex rounded-lg bg-muted p-0.5 text-xs">
                {([['all', 'Все'], ['income', 'Доход'], ['expense', 'Расход']] as const).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-md px-2.5 py-1.5 transition ${filter === value ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground'}`}>{label}</button>
                ))}
              </div>
              <NativeSelect value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)} className="w-full" aria-label="Фильтр по счёту">
                <NativeSelectOption value="all">Все счета</NativeSelectOption>
                {accounts.map((account) => <NativeSelectOption key={account} value={account}>{account}</NativeSelectOption>)}
              </NativeSelect>
              <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="h-10" aria-label="Дата от" />
              <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="h-10" aria-label="Дата до" />
              <Button variant="ghost" className="h-10" onClick={resetFilters}>Сбросить</Button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-muted px-3 py-1.5 text-muted-foreground">Найдено: {visibleTransactions.length}</span>
              <span className="rounded-full bg-[#edf8d9] px-3 py-1.5 text-[#537621]">Доходы: {money(visibleTotals.income)}</span>
              <span className="rounded-full bg-[#fff0ec] px-3 py-1.5 text-[#a94d3c]">Расходы: {money(visibleTotals.expense)}</span>
            </div>

            {!loading && visibleTransactions.length === 0 ? (
              <p className="py-14 text-center text-sm text-muted-foreground">По выбранным условиям операций нет</p>
            ) : (
              <>
                <div className="mt-5 hidden overflow-x-auto lg:block">
                  <table className="w-full min-w-[960px] text-left text-sm">
                    <thead className="border-b border-border text-xs text-muted-foreground">
                      <tr><th className="pb-3 font-medium">Дата</th><th className="pb-3 font-medium">Операция</th><th className="pb-3 font-medium">Категория</th><th className="pb-3 font-medium">Счёт</th><th className="pb-3 text-right font-medium">Сумма</th><th className="w-24 pb-3"><span className="sr-only">Действия</span></th></tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {visibleTransactions.map((transaction) => (
                        <tr key={transaction.id}>
                          <td className="py-3.5 pr-4 whitespace-nowrap text-muted-foreground">{longDate(transaction.date)}</td>
                          <td className="max-w-[280px] py-3.5 pr-4"><p className="truncate font-medium">{transaction.description}</p><p className="mt-1 truncate text-xs text-muted-foreground">{transaction.counterparty || 'Без контрагента'}{transaction.orderNumber ? ` · заказ №${transaction.orderNumber}` : ''}</p></td>
                          <td className="max-w-[220px] py-3.5 pr-4 text-muted-foreground"><p className="truncate">{transaction.category}</p></td>
                          <td className="py-3.5 pr-4 whitespace-nowrap text-muted-foreground">{transaction.account}</td>
                          <td className={`py-3.5 text-right font-semibold tabular-nums ${transaction.type === 'income' ? 'text-[#5c7f24]' : ''}`}>{transaction.type === 'income' ? '+' : '−'}{money(transaction.amount)}</td>
                          <td className="py-3.5 pl-3"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon-sm" onClick={() => editTransaction(transaction)} aria-label={`Редактировать ${transaction.description}`}><Pencil /></Button><Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(transaction)} aria-label={`Удалить ${transaction.description}`}><Trash2 /></Button></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-5 divide-y divide-border/70 lg:hidden">
                  {visibleTransactions.map((transaction) => (
                    <article key={transaction.id} className="py-4 first:pt-0 last:pb-0">
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl ${transaction.type === 'income' ? 'bg-[#edf8d9] text-[#537621]' : 'bg-[#fff0ec] text-[#c35642]'}`}>{transaction.type === 'income' ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}</div>
                        <div className="min-w-0 flex-1"><p className="font-medium">{transaction.description}</p><p className="mt-1 text-xs text-muted-foreground">{longDate(transaction.date)} · {transaction.account}</p><p className="mt-1 truncate text-xs text-muted-foreground">{transaction.category}</p></div>
                        <p className={`text-sm font-semibold tabular-nums ${transaction.type === 'income' ? 'text-[#5c7f24]' : ''}`}>{transaction.type === 'income' ? '+' : '−'}{money(transaction.amount)}</p>
                      </div>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => editTransaction(transaction)}><Pencil />Изменить</Button><Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(transaction)}><Trash2 />Удалить</Button></div>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
        )}
      </main>

      <div className="fixed inset-x-4 bottom-4 z-40 grid grid-cols-5 gap-1 rounded-2xl border border-white/10 bg-[#171b18]/95 p-2 shadow-2xl backdrop-blur-xl lg:hidden">
        <Button variant="ghost" className="h-12 flex-col gap-0.5 px-0 text-[10px] text-white hover:bg-white/10 hover:text-white" onClick={() => openDialog('expense')}><ArrowDownLeft className="size-4" />Расход</Button>
        <Button className="h-12 flex-col gap-0.5 bg-[#b5f23c] px-0 text-[10px] text-[#171b18] hover:bg-[#c5fb59]" onClick={() => openDialog('income')}><Plus className="size-4" />Доход</Button>
        <Button variant="ghost" className={`h-12 flex-col gap-0.5 px-0 text-[9px] text-white hover:bg-white/10 hover:text-white ${activePage === 'production' ? 'bg-white/10' : ''}`} onClick={() => navigateToPage('production')}><Factory className="size-4" />Производство</Button>
        <Button variant="ghost" className={`h-12 flex-col gap-0.5 px-0 text-[10px] text-white hover:bg-white/10 hover:text-white ${activePage === 'warehouse' ? 'bg-white/10' : ''}`} onClick={() => navigateToPage('warehouse')}><Boxes className="size-4" />Склад</Button>
        <Button variant="ghost" className={`h-12 flex-col gap-0.5 px-0 text-[9px] text-white hover:bg-white/10 hover:text-white ${activePage === 'analytics' ? 'bg-white/10' : ''}`} onClick={() => navigateToPage('analytics')}><BarChart3 className="size-4" />Аналитика</Button>
      </div>

      <Dialog
        open={financeDetails !== null}
        onOpenChange={(open) => {
          if (!open) setFinanceDetailsType(null);
        }}
      >
        {financeDetails && (
          <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-2xl">
            <DialogHeader className="border-b border-border px-5 py-5 pr-12 sm:px-6">
              <DialogTitle className="text-xl">{financeDetails.title}</DialogTitle>
              <DialogDescription>{financeDetails.description}</DialogDescription>
            </DialogHeader>

            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              <div className={`rounded-2xl p-4 ${financeDetails.type === 'cash' ? 'bg-[#171b18] text-white' : financeDetails.type === 'income' ? 'bg-[#edf8d9] text-[#263017]' : 'bg-[#fff0ec] text-[#743c31]'}`}>
                <p className={`text-xs font-medium ${financeDetails.type === 'cash' ? 'text-white/55' : financeDetails.type === 'income' ? 'text-[#52613b]' : 'text-[#955242]'}`}>
                  {financeDetails.totalLabel}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.04em]">
                  {money(financeDetails.total)}
                </p>
                <p className={`mt-1 text-xs ${financeDetails.type === 'cash' ? 'text-white/45' : financeDetails.type === 'income' ? 'text-[#52613b]' : 'text-[#955242]'}`}>
                  {financeDetails.periodLabel}
                </p>
                <dl className={`mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-xs ${financeDetails.type === 'cash' ? 'border-white/10' : 'border-current/10'}`}>
                  <div>
                    <dt className={financeDetails.type === 'cash' ? 'text-white/45' : 'opacity-65'}>{financeDetails.firstStatLabel}</dt>
                    <dd className="mt-0.5 whitespace-nowrap font-semibold tabular-nums">{financeDetails.firstStatValue}</dd>
                  </div>
                  <div>
                    <dt className={financeDetails.type === 'cash' ? 'text-white/45' : 'opacity-65'}>{financeDetails.secondStatLabel}</dt>
                    <dd className="mt-0.5 whitespace-nowrap font-semibold tabular-nums">{financeDetails.secondStatValue}</dd>
                  </div>
                </dl>
              </div>

              <section className="mt-5" aria-label={`Операции: ${financeDetails.title}`}>
                <header className="mb-2 flex items-center justify-between gap-3 px-1">
                  <h3 className="font-semibold">Операции</h3>
                  <p className="text-xs text-muted-foreground">
                    {financeDetails.transactions.length}{' '}
                    {pluralRu(financeDetails.transactions.length, 'запись', 'записи', 'записей')}
                  </p>
                </header>

                {financeDetails.transactions.length ? (
                  <div className="divide-y divide-border/70 overflow-hidden rounded-2xl border border-border">
                    {financeDetails.transactions.map((transaction) => (
                      <article key={transaction.id} className="px-4 py-3.5">
                        <div className="flex items-start gap-3">
                          <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl ${transaction.type === 'income' ? 'bg-[#edf8d9] text-[#5c7f24]' : 'bg-[#fff0ec] text-[#c35642]'}`}>
                            {transaction.type === 'income' ? <ArrowDownLeft className="size-3.5" /> : <ArrowUpRight className="size-3.5" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <p className="min-w-0 break-words font-medium leading-5">{transaction.description}</p>
                              <p className={`shrink-0 whitespace-nowrap font-semibold tabular-nums ${transaction.type === 'income' ? 'text-[#5c7f24]' : 'text-[#a84e3c]'}`}>
                                {transaction.type === 'income' ? '+' : '−'}{money(transaction.amount)}
                              </p>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {longDate(transaction.date)} · {transaction.counterparty || 'Без контрагента'}
                              {transaction.orderNumber ? ` · заказ №${transaction.orderNumber}` : ''}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground/80">
                              {transaction.category} · {transaction.account}
                            </p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center">
                    <ReceiptText className="mx-auto size-6 text-muted-foreground" />
                    <p className="mt-2 font-medium">{financeDetails.emptyTitle}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{financeDetails.emptyDescription}</p>
                  </div>
                )}
              </section>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={debtDetailsOpen} onOpenChange={setDebtDetailsOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border px-5 py-5 pr-12 sm:px-6">
            <DialogTitle className="text-xl">Клиентская задолженность</DialogTitle>
            <DialogDescription>
              Неоплаченные суммы по должникам и заказам из Google Таблицы.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="rounded-2xl bg-[#edf8d9] p-4 text-[#263017]">
              <p className="text-xs font-medium text-[#52613b]">Общий долг</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-[-0.04em]">
                {money(metrics.debt)}
              </p>
              <p className="mt-1 text-xs text-[#52613b]">
                {debtorGroups.length} {pluralRu(debtorGroups.length, 'должник', 'должника', 'должников')} ·{' '}
                {metrics.debtOrderCount} {pluralRu(metrics.debtOrderCount, 'заказ', 'заказа', 'заказов')}
              </p>
            </div>

            {debtorGroups.length ? (
              <div className="mt-5 space-y-4">
                {debtorGroups.map((group) => (
                  <section key={group.client} className="overflow-hidden rounded-2xl border border-border" aria-label={`Должник ${group.client}`}>
                    <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/45 px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#e4f3c8] text-[#5c7f24]">
                          <Users className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate font-semibold">{group.client}</h3>
                          <p className="text-xs text-muted-foreground">
                            {group.orders.length} {pluralRu(group.orders.length, 'заказ', 'заказа', 'заказов')}
                          </p>
                        </div>
                      </div>
                      <p className="shrink-0 font-semibold tabular-nums text-[#5c7f24]">{money(group.debt)}</p>
                    </header>

                    <div className="divide-y divide-border/70">
                      {group.orders.map((order) => (
                        <article key={order.number} className="px-4 py-3.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-medium leading-5">{order.name}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">Заказ №{order.number}</p>
                            </div>
                            <p className="shrink-0 font-semibold tabular-nums text-[#5c7f24]">{money(order.debt)}</p>
                          </div>
                          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-muted/40 px-3 py-2.5 text-xs sm:grid-cols-3">
                            <div>
                              <dt className="text-muted-foreground">Сумма заказа</dt>
                              <dd className="mt-0.5 whitespace-nowrap font-medium tabular-nums">{money(order.total)}</dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Оплачено</dt>
                              <dd className="mt-0.5 whitespace-nowrap font-medium tabular-nums">{money(order.paid)}</dd>
                            </div>
                            <div className="col-span-2 sm:col-span-1">
                              <dt className="text-muted-foreground">Остаток</dt>
                              <dd className="mt-0.5 whitespace-nowrap font-semibold tabular-nums text-[#5c7f24]">{money(order.debt)}</dd>
                            </div>
                          </dl>
                          <div className="mt-3 flex justify-end">
                            <Button
                              type="button"
                              className="min-h-10 w-full sm:w-auto"
                              disabled={!orderOptions.some((option) => option.number === order.number)}
                              aria-label={`Принять оплату по заказу №${order.number}`}
                              onClick={() => {
                                setDebtDetailsOpen(false);
                                openDialog('income');
                                setIncomeOrderNumber(order.number);
                                setIncomeAmount(String(order.debt));
                              }}
                            >
                              <WalletCards className="size-4" />
                              Принять оплату
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-dashed border-border px-4 py-8 text-center">
                <CheckCircle2 className="mx-auto size-6 text-[#6d942c]" />
                <p className="mt-2 font-medium">Задолженности нет</p>
                <p className="mt-1 text-xs text-muted-foreground">Все заказы оплачены полностью.</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogType !== null} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:max-w-lg sm:p-6" showCloseButton={!saving}>
          <form key={editingTransaction?.id ?? dialogType} onSubmit={submitTransaction} onChange={() => { setDuplicateReview(null); setSubmittedIncomeOrder(null); }} className="min-w-0">
            <DialogHeader>
              <DialogTitle className="text-xl">{dialogType === 'income' ? (editingTransaction ? (incomeMode === 'measurement' ? 'Редактировать замер' : 'Редактировать оплату') : 'Новый доход') : (editingTransaction ? 'Редактировать расход' : 'Новый расход')}</DialogTitle>
              <DialogDescription>{dialogType === 'income' ? (incomeMode === 'measurement' ? 'Оплата замера без заказа и карточки клиента.' : 'Клиент и вид платежа определятся автоматически.') : editingTransaction ? 'Изменения сразу обновят журнал и показатели.' : expenseMode === 'warehouse' ? 'Спишите материал и запишите его стоимость как расход из кассы. Заказ можно не выбирать.' : 'Запишите зарплату, услугу или другой денежный расход.'}</DialogDescription>
            </DialogHeader>
            {dialogType === 'expense' && !editingTransaction && (
              <div className="mt-5">
                <p className="mb-2 text-sm font-medium">Тип расхода</p>
                <fieldset className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
                  <legend className="sr-only">Тип расхода</legend>
                  <button
                    type="button"
                    aria-pressed={expenseMode === 'money'}
                    onClick={() => chooseExpenseMode('money')}
                    className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm transition ${expenseMode === 'money' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <WalletCards className="size-4" />
                    Денежный
                  </button>
                  <button
                    type="button"
                    aria-pressed={expenseMode === 'warehouse'}
                    onClick={() => chooseExpenseMode('warehouse')}
                    className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm transition ${expenseMode === 'warehouse' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    <Boxes className="size-4" />
                    Со склада
                  </button>
                </fieldset>
              </div>
            )}
            {dialogType === 'income' && !editingTransaction && (
              <fieldset className="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" disabled={saving}>
                <legend className="sr-only">Вид дохода</legend>
                {([['order', 'По заказу'], ['measurement', 'Замеры']] as const).map(([mode, label]) => (
                  <button key={mode} type="button" aria-pressed={incomeMode === mode}
                    onClick={() => { setIncomeMode(mode); setFormError(''); setDuplicateReview(null); setSubmittedIncomeOrder(null); }}
                    className={`min-h-10 rounded-lg px-3 text-sm transition ${incomeMode === mode ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>
                ))}
              </fieldset>
            )}
            <div className="mt-6 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
              {dialogType === 'income' ? <>
                {incomeMode === 'order' && <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="orderNumber">Заказ</Label>
                  <NativeSelect className="w-full" name="orderNumber" id="orderNumber" value={selectedIncomeOrder || editingTransaction?.orderNumber === incomeOrderNumber ? incomeOrderNumber : ''} onChange={(event) => setIncomeOrderNumber(event.target.value)} required>
                    <NativeSelectOption value="">{ordersLoading && !orderOptions.length ? 'Загружаю заказы…' : 'Выберите заказ'}</NativeSelectOption>
                    {editingTransaction?.orderNumber && !orderOptions.some((order) => order.number === editingTransaction.orderNumber) ? <NativeSelectOption value={editingTransaction.orderNumber}>№{editingTransaction.orderNumber} — название не найдено</NativeSelectOption> : null}
                    {orderOptions.map((order) => <NativeSelectOption key={order.number} value={order.number}>№{order.number} — {order.name || 'Без наименования'}{order.debt > 0 ? ` · к получению ${money(order.debt)}` : ''}</NativeSelectOption>)}
                  </NativeSelect>
                  {ordersLoaded && !ordersLoading && !ordersError && !orderOptions.length && !editingTransaction && <p className="text-sm text-muted-foreground">Нет заказов, по которым ожидается оплата.</p>}
                  {ordersError && !orderOptions.length ? <div className="flex items-center justify-between gap-3 rounded-lg bg-[#fff0ec] px-3 py-2 text-xs text-[#a14332]" role="alert"><span>{ordersError}</span><button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={() => void loadOrders()} disabled={ordersLoading}>{ordersLoading ? 'Загрузка…' : 'Повторить'}</button></div> : selectedIncomeOrder && <p className="text-xs text-muted-foreground">{selectedIncomeOrder.client || 'Клиент подставится из таблицы'}{orderBalanceHint(selectedIncomeOrder)}</p>}
                </div>}
                <div className="space-y-2"><Label htmlFor="date">Дата оплаты</Label><Input id="date" name="date" type="date" defaultValue={editingTransaction?.date ?? new Date().toISOString().slice(0, 10)} required className="h-10" /></div>
                <div className="space-y-2"><Label htmlFor="amount">Сумма, ₽</Label><Input id="amount" name="amount" type="number" min="1" step="1" inputMode="numeric" placeholder="0" value={incomeAmount} onChange={(event) => setIncomeAmount(event.target.value)} required className="h-10 text-lg font-semibold" />{incomeDebtAfter !== null && <p className={`text-xs ${incomeDebtAfter < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{incomeDebtAfter < 0 ? `Переплата ${money(-incomeDebtAfter)}` : `После оплаты долг ${money(incomeDebtAfter)}`}</p>}</div>
                <details className="border-t border-border pt-3 sm:col-span-2">
                  <summary className="cursor-pointer text-sm text-muted-foreground">Дополнительно</summary>
                  <div className="mt-4 grid gap-4">
                    <div className="space-y-2"><Label htmlFor="account">Касса / счёт</Label><NativeSelect className="w-full" name="account" id="account" defaultValue={editingTransaction?.account ?? accounts[0]}>{accounts.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></div>
                    <div className="space-y-2"><Label htmlFor="comment">Комментарий <span className="font-normal text-muted-foreground">(необязательно)</span></Label><Textarea id="comment" name="comment" placeholder="Детали операции" defaultValue={editingTransaction?.comment ?? ''} /></div>
                  </div>
                </details>
              </> : (editingTransaction || expenseMode === 'money') ? <>
                <div className="space-y-2"><Label htmlFor="date">Дата</Label><Input id="date" name="date" type="date" defaultValue={editingTransaction?.date ?? new Date().toISOString().slice(0, 10)} required className="h-10" /></div>
                <div className="space-y-2"><Label htmlFor="amount">Сумма, ₽</Label><Input id="amount" name="amount" type="number" min="1" step="1" inputMode="numeric" placeholder="0" defaultValue={editingTransaction?.amount} required className="h-10 text-lg font-semibold" /></div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="expense-category">Статья расхода</Label>
                  <Combobox
                    items={moneyExpenseCategories}
                    value={expenseCategory || null}
                    inputValue={expenseCategoryQuery}
                    onValueChange={(value) => {
                      const next = value ?? '';
                      setExpenseCategory(next);
                      setExpenseCategoryQuery(next);
                      setDuplicateReview(null);
                      setFormError('');
                    }}
                    onInputValueChange={(value, { reason }) => {
                      setExpenseCategoryQuery(value);
                      if (reason === 'input-change' || reason === 'input-clear') setExpenseCategory('');
                    }}
                    filter={(category, query) => matchesSearch([category], query)}
                    autoHighlight={false}
                  >
                    <ComboboxInput id="expense-category" className="h-10 w-full" placeholder="Начните вводить: зарплата, аренда…" showClear required />
                    <ComboboxContent>
                      <ComboboxEmpty>Подходящая статья не найдена</ComboboxEmpty>
                      <ComboboxList>
                        {(category: string) => <ComboboxItem key={category} value={category}>{category}</ComboboxItem>}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                  <p className="text-xs text-muted-foreground">Выберите точную статью из найденных вариантов.</p>
                </div>
                <div className="space-y-2 sm:col-span-2"><Label htmlFor="description">Описание</Label><Input id="description" name="description" placeholder="За что заплатили" defaultValue={editingTransaction?.description} required className="h-10" /></div>
                <details className="border-t border-border pt-3 sm:col-span-2">
                  <summary className="cursor-pointer text-sm text-muted-foreground">Дополнительно</summary>
                  <p className="mt-1 text-xs text-muted-foreground">Кому заплатили, касса / счёт и комментарий.</p>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2"><Label htmlFor="counterparty">Кому заплатили <span className="font-normal text-muted-foreground">(необязательно)</span></Label><Input id="counterparty" name="counterparty" placeholder="Поставщик или сотрудник" defaultValue={editingTransaction?.counterparty ?? ''} className="h-10" /></div>
                    <div className="space-y-2"><Label htmlFor="account">Касса / счёт</Label><NativeSelect className="w-full" name="account" id="account" defaultValue={editingTransaction?.account ?? accounts[0]} required>{accounts.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></div>
                    <div className="space-y-2 sm:col-span-2"><Label htmlFor="comment">Комментарий <span className="font-normal text-muted-foreground">(необязательно)</span></Label><Textarea id="comment" name="comment" placeholder="Детали операции" defaultValue={editingTransaction?.comment ?? ''} /></div>
                  </div>
                </details>
              </> : <>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="warehouse-order">Заказ <span className="font-normal text-muted-foreground">(необязательно)</span></Label>
                  <NativeSelect
                    className="w-full"
                    id="warehouse-order"
                    value={warehouseOrderNumber}
                    onChange={(event) => {
                      setWarehouseOrderNumber(event.target.value);
                      setFormError('');
                    }}
                    disabled={ordersLoading || !ordersLoaded || Boolean(ordersError) || !orders.length}
                  >
                    <NativeSelectOption value="">Без заказа</NativeSelectOption>
                    {orders.map((order) => <NativeSelectOption key={order.number} value={order.number}>№{order.number} — {order.name || 'Без наименования'}</NativeSelectOption>)}
                  </NativeSelect>
                  {ordersError && <div className="flex items-center justify-between gap-3 rounded-lg bg-[#fff0ec] px-3 py-2 text-xs text-[#a14332]" role="alert"><span>{ordersError}</span><button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={() => void loadOrders()} disabled={ordersLoading}>{ordersLoading ? 'Загрузка…' : 'Повторить'}</button></div>}
                  {ordersLoaded && !ordersLoading && !ordersError && !orders.length && <p className="text-xs text-muted-foreground">Доступные заказы не найдены.</p>}
                </div>

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="warehouse-material">Материал со склада</Label>
                  {warehouseLoading && <div className="flex h-10 items-center rounded-lg border border-input px-3 text-sm text-muted-foreground">Загружаю склад…</div>}
                  {!warehouseLoading && warehouseError && <div className="flex items-center justify-between gap-3 rounded-lg bg-[#fff0ec] px-3 py-2 text-xs text-[#a14332]" role="alert"><span>{warehouseError}</span><button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={() => void loadWarehouseItems(true)}>Повторить</button></div>}
                  {!warehouseLoading && !warehouseError && warehouseLoaded && !warehouseItems.length && <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">На складе пока нет материалов</div>}
                  {!warehouseLoading && !warehouseError && warehouseItems.length > 0 && (
                    <Combobox
                      items={warehouseItems}
                      value={selectedWarehouseItem}
                      inputValue={warehouseQuery}
                      onValueChange={(item) => {
                        setSelectedWarehouseItem(item);
                        setWarehouseQuery(item?.name ?? '');
                        setWarehouseQuantity('');
                        setFormError('');
                      }}
                      onInputValueChange={(value, { reason }) => {
                        setWarehouseQuery(value);
                        if (reason === 'input-change' || reason === 'input-clear') {
                          setSelectedWarehouseItem(null);
                          setWarehouseQuantity('');
                        }
                      }}
                      filter={(item, query) => matchesSearch([
                        item.sku,
                        item.name,
                        item.category,
                        item.expenseCategory,
                        item.location,
                        item.unit,
                      ], query)}
                      itemToStringLabel={(item) => item.name}
                      itemToStringValue={(item) => item.sku}
                      isItemEqualToValue={(item, value) => item.sku === value.sku}
                      autoHighlight={false}
                      limit={50}
                    >
                      <ComboboxInput id="warehouse-material" className="h-10 w-full" placeholder="Название, артикул, место или характеристика…" showClear required />
                      <ComboboxContent>
                        <ComboboxEmpty>Материал не найден по всему складу</ComboboxEmpty>
                        <ComboboxList>
                          {(item: WarehouseLookupItem) => {
                            const available = Math.max(item.stock - item.reserved, 0);
                            return (
                              <ComboboxItem key={item.sku} value={item} className="py-2.5">
                                <div className="min-w-0 flex-1 pr-2">
                                  <p className="truncate font-medium">{item.name}</p>
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.sku} · {item.category} · {item.location}</p>
                                </div>
                                <span className={`shrink-0 text-xs tabular-nums ${available > 0 ? 'text-muted-foreground' : 'text-destructive'}`}>{available > 0 ? `${available.toLocaleString('ru-RU')} ${item.unit}` : 'Нет остатка'}</span>
                              </ComboboxItem>
                            );
                          }}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  )}
                </div>

                {selectedWarehouseItem && (
                  <div className="rounded-2xl bg-muted/55 p-3 sm:col-span-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{selectedWarehouseItem.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{selectedWarehouseItem.sku} · {selectedWarehouseItem.location}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs text-muted-foreground">Доступно</p>
                        <p className="font-semibold tabular-nums">{selectedWarehouseAvailable.toLocaleString('ru-RU')} {selectedWarehouseItem.unit}</p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="warehouse-quantity">Количество{selectedWarehouseItem ? `, ${selectedWarehouseItem.unit}` : ''}</Label>
                  <Input
                    id="warehouse-quantity"
                    value={warehouseQuantity}
                    onChange={(event) => {
                      setWarehouseQuantity(event.target.value);
                      setFormError('');
                    }}
                    type="number"
                    min="0.01"
                    max={selectedWarehouseItem ? selectedWarehouseAvailable : undefined}
                    step="0.01"
                    inputMode="decimal"
                    placeholder="0"
                    required
                    disabled={!selectedWarehouseItem || selectedWarehouseAvailable <= 0}
                    className="h-11 text-lg font-semibold"
                  />
                  {warehouseRemaining !== null && (
                    <p className={`text-xs ${warehouseRemaining < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {warehouseRemaining < 0 ? `Не хватает ${Math.abs(warehouseRemaining).toLocaleString('ru-RU')} ${selectedWarehouseItem?.unit}` : `После списания останется ${warehouseRemaining.toLocaleString('ru-RU')} ${selectedWarehouseItem?.unit}`}
                    </p>
                  )}
                  {selectedWarehouseItem && <p className="text-sm font-medium">Расход из кассы: {warehouseExpenseAmount !== null ? money(warehouseExpenseAmount) : '—'}<span className="mt-1 block text-xs font-normal text-muted-foreground">По цене склада {selectedWarehouseItem.price.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽ за {selectedWarehouseItem.unit}. Сумма округляется до рубля.</span></p>}
                  {selectedWarehouseItem && !(selectedWarehouseItem.price > 0) && <p className="text-xs text-destructive">Для записи расхода заполните цену в Google Таблице, лист «Склад».</p>}
                </div>
                <details className="border-t border-border pt-3 sm:col-span-2">
                  <summary className="cursor-pointer text-sm text-muted-foreground">Дополнительно</summary>
                  <div className="mt-4"><Label htmlFor="comment">Комментарий <span className="font-normal text-muted-foreground">(необязательно)</span></Label><Textarea className="mt-2" id="comment" name="comment" placeholder="Для чего использовали материал" /></div>
                </details>
              </>}
            </div>
            {formError && <p className="mt-4 rounded-xl bg-[#fff0ec] px-3 py-2.5 text-sm text-[#a14332]" role="alert">{formError}</p>}
            {duplicateReview && (
              <div ref={duplicateReviewRef} tabIndex={-1} role="alert" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 outline-none">
                <p className="font-semibold">Возможно, эта операция уже внесена</p>
                <p className="mt-1">Найдены похожие записи с той же суммой и разницей дат до 3 дней. Новая операция пока не сохранена.</p>
                <ul className="mt-3 space-y-2">
                  {duplicateReview.matches.map(item => (
                    <li key={item.id} className="rounded-lg bg-white/70 p-3 break-words">
                      <p className="font-semibold">{item.date.split('-').reverse().join('.')} · {money(item.amount)}</p>
                      <p>{item.description || item.category}{item.orderNumber ? ` · заказ №${item.orderNumber}` : ''}</p>
                      <p>{item.account}{item.counterparty ? ` · ${item.counterparty}` : ''}</p>
                      {item.comment && <p className="mt-1">{item.comment}</p>}
                    </li>
                  ))}
                </ul>
                {duplicateReview.total > duplicateReview.matches.length && <p className="mt-2">Всего похожих записей: {duplicateReview.total}. Показаны последние пять.</p>}
                <p className="mt-3">Если это отдельный платёж или расход, подтвердите сохранение.</p>
                <div className="mt-3 flex flex-col gap-2">
                  <Button type="button" variant="outline" disabled={saving} onClick={() => setDuplicateReview(null)}>Вернуться к проверке</Button>
                  <Button type="submit" name="confirm-duplicate" disabled={saving}>Сохранить отдельной операцией</Button>
                </div>
              </div>
            )}
            <DialogFooter className="mx-0 -mb-1 mt-6 rounded-xl border-0 bg-muted/60 p-3">
              <Button type="button" variant="ghost" onClick={closeDialog} disabled={saving}>Отмена</Button>
              <Button
                type="submit"
                className="bg-[#171b18] text-white hover:bg-[#2a312c]"
                disabled={
                  saving || Boolean(duplicateReview) ||
                  (dialogType === 'income' && incomeMode === 'order' && !incomeOrderNumber && !orderOptions.length) ||
                  (dialogType === 'expense' && (editingTransaction || expenseMode === 'money') && !expenseCategory) ||
                  (dialogType === 'expense' && !editingTransaction && expenseMode === 'warehouse' && !warehouseCanSubmit)
                }
              >
                {saving ? 'Сохраняю…' : editingTransaction ? 'Сохранить изменения' : dialogType === 'income' ? 'Записать оплату' : expenseMode === 'warehouse' ? 'Списать со склада' : 'Сохранить расход'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить операцию?</AlertDialogTitle>
            <AlertDialogDescription>{deleteTarget ? `${deleteTarget.description} · ${money(deleteTarget.amount)}. Показатели пересчитаются автоматически.` : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Отмена</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void deleteSelectedTransaction()} disabled={deleting}>{deleting ? 'Удаляю…' : 'Удалить'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {savedNotice && <div className="fixed right-4 top-20 z-[60] flex items-center gap-2 rounded-xl bg-[#171b18] px-4 py-3 text-sm font-medium text-white shadow-xl lg:top-6" role="status"><CheckCircle2 className="size-4 text-[#b5f23c]" />{savedNotice}</div>}
    </div>
  );
}
