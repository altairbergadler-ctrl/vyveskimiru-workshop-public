export function responseTime(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const seconds = Math.round(value);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours} ч${rest ? ` ${rest} мин` : ''}`;
}
