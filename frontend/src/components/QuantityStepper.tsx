interface QuantityStepperProps {
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  label: string;
  onChange: (value: number) => void;
}

export function QuantityStepper({
  value,
  min = 1,
  max = 100,
  disabled = false,
  label,
  onChange,
}: QuantityStepperProps) {
  const normalized = Math.min(max, Math.max(min, Math.trunc(value || min)));

  return (
    <div className="nova-quantity-stepper" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`Giảm ${label}`}
        disabled={disabled || normalized <= min}
        onClick={() => onChange(normalized - 1)}
      >
        −
      </button>
      <output aria-live="polite" aria-label={`${label}: ${normalized}`}>{normalized}</output>
      <button
        type="button"
        aria-label={`Tăng ${label}`}
        disabled={disabled || normalized >= max}
        onClick={() => onChange(normalized + 1)}
      >
        +
      </button>
    </div>
  );
}
