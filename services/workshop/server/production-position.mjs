import crypto from 'node:crypto';
import {
  requireValue,
  validateRoute,
  stageConfigurationIssue,
  isProductionOrderActive,
} from './production-planner.mjs';

// Shared read projection of the existing production routes, not a second catalog.
export function routeProducts(state) {
  return state.products.filter(
    (p) => !p.sourceProductId && !p.id.startsWith('position-route-'),
  );
}
export function productionProductCatalog(state) {
  const products = routeProducts(state).map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit,
    version: p.versions.at(-1).version,
  }));
  const positions = state.items
    .filter((i) => i.sourcePosition)
    .map((i) => {
      const product = state.products.find((p) => p.id === i.productId);
      const source =
        product?.sourceProductId ||
        (products.some((p) => p.id === i.productId) ? i.productId : null);
      return {
        sourcePosition: i.sourcePosition,
        name: i.name,
        productId: source,
      };
    });
  return {
    products,
    positions,
    revision: state.revision,
    source: 'production-routes',
  };
}
export function productionPositionTemplates(state) {
  const kinds = {
    'Уличная вывеска': 'street',
    'Неоновая вывеска': 'neon',
    'Плоттерная резка': 'plotter',
  };
  return routeProducts(state).map((p) => {
    const stages = p.versions
      .at(-1)
      .stages.filter((s) => s.name !== 'Монтаж')
      .map((s, index) => ({
        name: s.name,
        order: index + 1,
        hours: s.minutes / 60,
      }));
    return {
      id: 'route:' + p.id,
      name: p.name,
      unit: p.unit,
      formKind: kinds[p.name] || 'route',
      stages,
      totalHours: stages.reduce((sum, s) => sum + s.hours, 0),
    };
  });
}

// Freeze the selected route in the existing position journal before either write.
export function preparePositionRoute(
  state,
  { orderId, position, allowedUnits },
) {
  requireValue(
    isProductionOrderActive(state.orders.find((o) => o.id === orderId)),
    'Заказ закрыт или не найден.',
  );
  if (position.template === 'custom') return null;
  const byId = position.template.startsWith('route:');
  const candidates = byId
    ? routeProducts(state).filter((p) => p.id === position.template.slice(6))
    : state.products.filter((p) => p.name === position.name);
  if (byId)
    requireValue(
      candidates.length === 1 && candidates[0].name === position.name,
      'Продукт изменён или удалён. Обновите список изделий.',
    );
  if (!candidates.length) return null;
  const withoutInstallation = candidates.filter((p) =>
    p.versions.at(-1).stages.every((s) => s.name !== 'Монтаж'),
  );
  const choices = withoutInstallation.length ? withoutInstallation : candidates;
  requireValue(
    choices.length === 1,
    'Есть несколько маршрутов этого изделия. Уточните шаблон в разделе «Продукты».',
  );
  const product = structuredClone(choices[0]);
  const route = product.versions.at(-1);
  const stages = route.stages.filter((s) => s.name !== 'Монтаж');
  validateRoute(stages);
  for (const stage of stages)
    requireValue(
      !stageConfigurationIssue(stage, state),
      stageConfigurationIssue(stage, state),
    );
  requireValue(
    product.unit === 'позиция' || product.unit === position.unit,
    'Единица позиции не совпадает с маршрутом производства.',
  );
  if (product.unit === 'позиция' && allowedUnits)
    requireValue(
      allowedUnits.includes(position.unit),
      'Выберите единицу измерения из настроек таблицы.',
    );
  // A legacy norm covers the entire position, not every letter in its quantity.
  const quantity = product.unit === 'позиция' ? 1 : position.quantity;
  if (stages.length !== route.stages.length) {
    product.sourceProductId = product.sourceProductId || product.id;
    product.id =
      'position-route-' +
      crypto
        .createHash('sha256')
        .update(JSON.stringify({ id: product.id, stages }))
        .digest('hex')
        .slice(0, 20);
    product.versions = [{ version: 1, stages }];
  }
  product.needsSetup = false;
  return { product, quantity };
}
