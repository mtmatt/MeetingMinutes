import { Minus, Plus } from "lucide-react";

/** A small number input with - / + buttons (speaker counts). */
export function Stepper({ value, onChange, min = 1, max = 20 }: { value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <div className="stepper">
      <button type="button" className="icon-btn sm" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="-">
        <Minus />
      </button>
      <span className="mono">{value}</span>
      <button type="button" className="icon-btn sm" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="+">
        <Plus />
      </button>
    </div>
  );
}
