import fs from 'node:fs';
import path from 'node:path';
import { fixtures } from './fixtures.mjs';

export function seedCancelledFixture(directory) {
  const tables = fixtures();
  for (const status of ['Готов к выдаче', 'Монтаж', 'Сдан', 'Отменён']) {
    tables['Настройки'].push(['', '', '', '', '', status]);
  }
  fs.writeFileSync(path.join(directory, 'sheet.json'), JSON.stringify(tables));
}
