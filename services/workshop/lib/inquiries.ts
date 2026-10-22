export type InquiryCandidate = {
  chatId: string;
  itemId: string;
  itemTitle: string;
  person: string;
  createdAt: string;
  updatedAt: string;
  signalsAt: string | null;
  level: 'strong' | 'possible' | 'weak';
  score: number;
  reasons: { code: string; label: string }[];
  anchorDate: string | null;
  afterOrder: boolean;
  messagesLimited: boolean;
  messagesMissing: boolean;
  signalsStale: boolean;
  messagesRead: number | null;
  incomingObserved: number | null;
  confirmed: false;
};
export type InquiryOrder = {
  id: string;
  title: string;
  client: string;
  createdDate: string | null;
  status: string;
  amount: number | null;
  paid: number | null;
  profit: number | null;
  manualSource: string | null;
  candidates: InquiryCandidate[];
  totalCandidates: number;
  ambiguous: boolean;
  suggestedChatId: string | null;
  state: 'suggested' | 'review' | 'source_only' | 'unknown';
};
export type InquiryReport = {
  modelVersion: string;
  generatedAt: string;
  period: { from: string; to: string };
  windowDays: number;
  mode: string;
  rows: InquiryOrder[];
  dialogs: {
    id: string;
    itemId: string;
    itemTitle: string;
    person: string;
    createdAt: string;
    updatedAt: string;
    incomingObserved: number | null;
    messagesRead: number | null;
    messagesLimited: boolean;
    possibleOrders: string[];
    suggestedOrders: string[];
  }[];
  byItem: {
    itemId: string;
    title: string;
    orders: number;
    amount: number | null;
    paid: number | null;
    profit: number | null;
    strong: number;
    estimated: true;
  }[];
  summary: {
    orders: number;
    dialogs: number;
    withCandidates: number;
    suggested: number;
    strong: number;
    ambiguous: number;
    sourceOnly: number;
    unknown: number;
    suggestedAmount: number | null;
    suggestedPaid: number | null;
    suggestedProfit: number | null;
    cancelled: number;
    ordersWithoutDate: number;
  };
  limitations: string[];
  ordersLoadedAt: string | null;
  ordersStale: boolean;
  source: {
    enabled: boolean;
    automatic: boolean;
    intervalMinutes?: number;
    jobs: {
      id: string;
      createdAt: string;
      finishedAt: string | null;
      state: string;
      limited: number;
      automatic: number;
      total: number;
      done: number;
      failed: number;
    }[];
    errors?: { kind: string; state: string; code: string; nextAt: number }[];
    limits?: {
      historyDays: number;
      messagesPerChat: number;
      changedChatsPerRun: number;
    };
  };
  coverage: {
    loadedDialogs: number;
    dialogsWithMessages: number;
    dialogsWithIncoming: number;
    truncatedDialogs: number;
    staleDialogs: number;
  };
};
export function inquiryCsv(report: InquiryReport, rows = report.rows) {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const data: (string | number | null | undefined)[][] = [
    [
      'Период с',
      'Период по',
      'Модель',
      'Режим',
      'Заказ',
      'Клиент',
      'Название',
      'Статус',
      'Сумма заказа RUB',
      'Оплачено по заказу RUB',
      'Оценочная прибыль заказа RUB (50% до рекламы)',
      'Источник клиента',
      'Диалог-кандидат',
      'Объявление',
      'Уровень',
      'Основания',
      'Неоднозначно',
      'Подтверждено',
    ],
  ];
  for (const row of rows) {
    const c = row.candidates.find((c) => c.chatId === row.suggestedChatId);
    data.push([
      report.period.from,
      report.period.to,
      report.modelVersion,
      report.mode,
      row.id,
      row.client,
      row.title,
      row.status,
      row.amount,
      row.paid,
      row.profit,
      row.manualSource,
      c?.chatId,
      c?.itemTitle,
      c?.level,
      c?.reasons.map((r) => r.label).join('; '),
      row.ambiguous ? 'да' : 'нет',
      'нет',
    ]);
  }
  return '\ufeff' + data.map((r) => r.map(cell).join(';')).join('\r\n');
}
