import { useLayoutEffect, useRef } from 'react';

/** Measure natural card heights; dense grid placement fills earlier column gaps. */
export function useWidgetPacking(widgetIds: string) {
  const gridRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = Array.from(grid.children) as HTMLElement[];
    let frame = 0;
    const measure = () => {
      frame = 0;
      const heights = cards.map(
        (card) => Math.ceil(card.getBoundingClientRect().height) + 16,
      );
      cards.forEach((card, index) => {
        const span = String(heights[index]);
        if (card.style.getPropertyValue('--hw-row-span') !== span)
          card.style.setProperty('--hw-row-span', span);
      });
      grid.dataset.packed = 'true';
    };
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure);
    });
    cards.forEach((card) => observer.observe(card));
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [widgetIds]);
  return gridRef;
}
