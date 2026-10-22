import test from 'node:test';
import assert from 'node:assert/strict';
import { orderCommentParts, replaceOrderComment } from '../modules/orders/public/board-model.js';

test('comment-only editing preserves legacy product descriptions when adding, changing and clearing notes', () => {
  const original = 'ПРОДУКЦИЯ\n1. Вывеска\nРазмер: 2 × 1 м';
  const separator = '\n\nКОММЕНТАРИЙ К ЗАКАЗУ\n';
  const note = 'Первая строка\nВторая строка <текст> =SUM(A1)';
  for (const raw of [original, original + separator + 'Прежняя заметка']) {
    const result = replaceOrderComment(raw, note);
    assert.equal(result, original + separator + note);
    assert.deepEqual(orderCommentParts(result), { original, comment: note });
    assert.equal(replaceOrderComment(result, ''), original);
  }
});

test('ordinary and empty comments remain plain text, including additional separator text', () => {
  for (const raw of ['', 'Примечание\n\nКОММЕНТАРИЙ К ЗАКАЗУ\nДетали', '=SUM(A1)', '<script>text</script>']) {
    assert.deepEqual(orderCommentParts(raw), { original: '', comment: raw });
    assert.equal(replaceOrderComment(raw, 'Новый\nтекст'), 'Новый\nтекст');
    assert.equal(replaceOrderComment(raw, ''), '');
  }
});
