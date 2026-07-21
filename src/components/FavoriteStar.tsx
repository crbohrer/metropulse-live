import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  active: boolean;
  onClick: () => void;
  size?: number;
  className?: string;
  label?: string;
}

export function FavoriteStar({ active, onClick, size = 16, className, label }: Props) {
  return (
    <button
      type="button"
      aria-label={active ? `Unstar ${label ?? "stop"}` : `Star ${label ?? "stop"}`}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1 transition",
        "hover:bg-white/10 focus:outline-none focus:ring-1 focus:ring-amber-400/60",
        active ? "text-amber-400" : "text-muted-foreground/70 hover:text-amber-300",
        className,
      )}
    >
      <Star size={size} fill={active ? "currentColor" : "none"} strokeWidth={2} />
    </button>
  );
}
