export const realFixture = {
  catalog: {
    source: 'production-routes',
    products: [
      { id: 'signs', name: 'Вывеска' },
      { id: 'plates', name: 'Табличка' },
    ],
    positions: [],
  },
  ads: {
    enabled: true,
    period: { dateFrom: '2026-09-01', dateTo: '2026-09-09' },
    loadedAt: '2026-09-09T14:00:00Z',
    history: [{ kind: 'items', from: '2026-09-01', to: '2026-09-09' }],
    coverage: { withoutStats: 1 },
    rows: [
      {
        id: '1',
        title: 'Демо · Световые вывески',
        metrics: { spending: 100000, contacts: 4, views: 50 },
      },
      {
        id: '2',
        title: 'Демо · Таблички',
        metrics: { spending: 0, contacts: 0, views: 0 },
      },
      { id: '3', title: 'Демо · Буквы и вывески', metrics: null },
    ],
  },
  business: {
    sources: [
      { id: 'orders', state: 'ready', loadedAt: '2026-09-09T14:00:00Z' },
    ],
    orders: {
      rows: [
        {
          id: '101',
          title: 'Демо-заказ А',
          createdDate: '2026-09-03',
          status: 'Готов',
          amount: 2000,
          paid: 1000,
          sourceKnown: true,
          source: 'Авито',
          items: [{ name: 'Вывеска' }],
        },
        {
          id: '102',
          title: 'Демо-заказ Б',
          createdDate: '2026-09-04',
          status: 'В работе',
          amount: 3000,
          paid: 3000,
          items: [{ name: 'Табличка' }, { name: 'Вывеска' }],
        },
        {
          id: '103',
          title: 'Демо-заказ В',
          createdDate: '2026-09-06',
          status: 'Отменён',
          amount: 1000,
          paid: 1000,
          items: [{ name: 'Вывеска' }],
        },
      ],
    },
  },
  inquiries: {
    dialogs: [
      {
        id: 'chat1',
        itemId: '1',
        createdAt: '2026-09-01T00:00:00Z',
        incomingObserved: 2,
      },
      {
        id: 'chat2',
        itemId: '2',
        createdAt: '2026-08-30T00:00:00Z',
        incomingObserved: 1,
      },
      {
        id: 'chat3',
        itemId: '2',
        createdAt: '2026-09-02T00:00:00Z',
        incomingObserved: 0,
      },
    ],
    coverage: { loadedDialogs: 3, dialogsWithIncoming: 2, truncatedDialogs: 0 },
    byItem: [{ itemId: '1', paid: 999999, estimated: true }],
    rows: [{ id: '101', suggestedChatId: 'chat1' }],
  },
};
