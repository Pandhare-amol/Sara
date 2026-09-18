import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";

interface CursorPosition {
  x: number;
  y: number;
  screen_width?: number;
  screen_height?: number;
}

interface SaraCursorOverlayProps {
  active: boolean;
}

export function SaraCursorOverlay({ active }: SaraCursorOverlayProps) {
  const [position, setPosition] = useState<CursorPosition | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    if (!active) {
      setPosition(null);
      setOnline(false);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch("/api/desktop/mouse-position", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload.ok || cancelled) return;
        setPosition(payload.position);
        setOnline(true);
      } catch {
        if (!cancelled) setOnline(false);
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 180);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active]);

  if (!active || !position) return null;

  const screenWidth = position.screen_width || window.screen.width;
  const screenHeight = position.screen_height || window.screen.height;
  const left = Math.max(0, Math.min(window.innerWidth - 28, (position.x / screenWidth) * window.innerWidth));
  const top = Math.max(0, Math.min(window.innerHeight - 34, (position.y / screenHeight) * window.innerHeight));

  return (
    <div
      className="fixed inset-0 z-[100] pointer-events-none"
      aria-hidden="true"
      data-online={online}
    >
      <div
        className="absolute transition-[left,top] duration-100 ease-out"
        style={{ left, top }}
      >
        <MousePointer2
          size={32}
          strokeWidth={2.2}
          className="text-cyan-300 drop-shadow-[0_0_7px_rgba(34,211,238,0.95)]"
        />
        <span className="absolute left-6 top-7 h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,1)]" />
      </div>
    </div>
  );
}
