export type Link = { revision: number; productId: string | null };
export type ResponseStats = { secondsTotal: number; answered: number; waiting: number; unknown: number; averageSeconds: number | null };
export type LiveAd = {
  id: string;
  title: string;
  status: string;
  url: string | null;
  productId: string | null;
  mapping: Link | null;
  impressions: number | null;
  views: number | null;
  contacts: number | null;
  spend: number | null;
  contactRate: number | null;
  costContact: number | null;
  receipts: number | null;
  orders: number | null;
  profit: number | null;
  result: number | null;
  romi: number | null;
  orderRate: number | null;
  confirmedOrders: number | null;
  reason: string;
  firstResponseSeconds?: number | null;
  responseStats?: ResponseStats | null;
};
export type LiveReport = {
  dailyItems?: {expectedDays:number;completeDays:number;sourceTimezone:string;job:{id:string;state:string;total:number;done:number;failed:number}|null}|null;
  responses?: {
    enabled: boolean; schedule: string[]; timezone: string; nextAt: number | null;
    loadedAt: string | null; state: string; partial: boolean; stale: boolean;
    indexedChats: number; unverified: number; pending: number; failed: number;
    indexLimited: boolean; undated: number; summary: ResponseStats;
  } | null;
  serviceAutomation?: {
    enabled: boolean;
    run: {
      day: string;
      state: string;
      at: string;
      stats: {
        analyzed: number;
        assigned: number;
        unresolved: number;
        unchanged: number;
        failed: number;
        deferred: number;
        skipped: number;
      };
    } | null;
    assignments: { orderId: string; productId: string; revision: number }[];
    unresolved?: { entityId: string; reason: string }[];
  } | null;
  adServiceAutomation?: {
    enabled: boolean;
    run: {
      day: string;
      state: string;
      at: string;
      stats: {
        analyzed: number;
        assigned: number;
        unresolved: number;
        unchanged: number;
        failed: number;
        deferred: number;
        skipped: number;
      };
    } | null;
    assignments: { adId: string; productId: string; revision: number }[];
    unresolved?: { entityId: string; reason: string }[];
  } | null;
  attribution?: {
    enabled: boolean;
    model: string;
    effort: string;
    timezone: string;
    nextAt: number | null;
    run: {
      day: string;
      state: string;
      finishedAt: string | null;
      stats: {
        analyzed?: number;
        unchanged?: number;
        failed?: number;
        deferred?: number;
        limited?: boolean;
      };
    } | null;
    pending: {
      id: string;
      orderId: string;
      chatId: string;
      itemId: string;
      itemTitle: string;
      reasons: string[];
      messageIds: string[];
    }[];
    links: {
      orderId: string;
      chatId: string;
      itemId: string;
      itemTitle: string;
      suggestionId: string;
    }[];
    facts: {
      itemId: string;
      title: string;
      orders: number;
      orderIds: string[];
      receipts: number | null;
      profit: number | null;
    }[];
  } | null;
  generatedAt: string;
  period: { from: string; to: string; days: number };
  sources: { label: string; state: string; loadedAt: string | null }[];
  products: {
    id: string;
    name: string;
    unit: string;
    version: number;
    adCount: number;
    contacts: number | null;
    orders: number | null;
    receipts: number | null;
    spend: number | null;
    spendComplete: boolean;
    result: number | null;
    profit: number | null;
  }[];
  rows: LiveAd[];
  orders: {
    id: string;
    title: string;
    client?: string;
    date: string;
    status: string;
    amount: number | null;
    profit: number | null;
    receipts: number | null;
    productId: string | null;
    mapping: Link | null;
    periodOrder: boolean;
  }[];
  clients: { name: string; date: string; orders: number }[] | null;
  summary: {
    spend: number | null;
    spendComplete: boolean;
    receipts: number | null;
    profit: number | null;
    result: number | null;
    romi: number | null;
    roas: number | null;
    orders: number | null;
    newClients: number | null;
    contacts: number | null;
    views: number | null;
    impressions: number | null;
    clientsWithOrders: number | null;
    cohortOrders: number | null;
    paidClients: number | null;
    allocated: number | null;
    unallocated: number | null;
    unassignedOrders: number;
    unassignedReceipts: number | null;
  };
  quality: {
    missingClientDates: number | null;
    unknownOrderSources: number;
    unknownPaymentSource: number | null;
    issues: { message: string }[];
  };
  daily: {
    date: string;
    responseSecondsTotal?: number | null;
    responseAnswered?: number | null;
    responseWaiting?: number | null;
    receipts: number | null;
    spend: number | null;
    contacts: number | null;
    impressions: number | null;
    views: number | null;
    orders: number | null;
    profit: number | null;
  }[];
  avito: {
    enabled: boolean;
    loadedAt: string | null;
    stale: boolean;
    reported: number;
    inventory: number;
    withoutStats: number;
    failures: number;
    jobs: { state: string; done: number; total: number; failed: number }[];
  };
};
