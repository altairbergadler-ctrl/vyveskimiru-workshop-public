import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

type Drag = {
  id: string;
  pointerId: number;
  handle: HTMLButtonElement;
  x: number;
  y: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  active: boolean;
};
const target = (drag: Drag) =>
  document
    .elementFromPoint(drag.x, drag.y)
    ?.closest<HTMLElement>('[data-widget-id]')?.dataset.widgetId || null;
export function useWidgetDrag(onMove: (id: string, targetId: string) => void) {
  const current = useRef<Drag | null>(null);
  const frame = useRef(0);
  const moveCallback = useRef(onMove);
  const [preview, setPreview] = useState<Drag | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  useLayoutEffect(() => {
    moveCallback.current = onMove;
  }, [onMove]);
  const cancel = useCallback(() => {
    const drag = current.current;
    current.current = null;
    cancelAnimationFrame(frame.current);
    document.documentElement.classList.remove('hw-drag-active');
    setPreview(null);
    setTargetId(null);
    if (drag?.handle.hasPointerCapture(drag.pointerId))
      drag.handle.releasePointerCapture(drag.pointerId);
  }, []);
  useEffect(() => {
    const publish = (drag: Drag) => {
      setPreview({ ...drag });
      setTargetId(target(drag));
    };
    const scroll = () => {
      const drag = current.current;
      if (!drag?.active) return;
      const speed =
        drag.y < 64 ? -14 : drag.y > window.innerHeight - 64 ? 14 : 0;
      if (speed) {
        window.scrollBy(0, speed);
        publish(drag);
      }
      frame.current = requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      const drag = current.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) {
        cancel();
        return;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (
        !drag.active &&
        Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5
      )
        return;
      event.preventDefault();
      if (!drag.active) {
        drag.active = true;
        document.documentElement.classList.add('hw-drag-active');
        frame.current = requestAnimationFrame(scroll);
      }
      publish(drag);
    };
    const finish = (event: PointerEvent) => {
      const drag = current.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.active) {
        drag.x = event.clientX;
        drag.y = event.clientY;
        const destination = target(drag);
        if (destination && destination !== drag.id)
          moveCallback.current(drag.id, destination);
      }
      cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(frame.current);
      document.documentElement.classList.remove('hw-drag-active');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [cancel]);
  return {
    preview,
    targetId,
    cancel,
    start: (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
      if (event.button !== 0) return;
      const card = event.currentTarget.closest('article');
      if (!card) return;
      cancel();
      const bounds = card.getBoundingClientRect();
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      current.current = {
        id,
        pointerId: event.pointerId,
        handle: event.currentTarget,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - bounds.left,
        offsetY: event.clientY - bounds.top,
        width: bounds.width,
        height: bounds.height,
        active: false,
      };
    },
  };
}
