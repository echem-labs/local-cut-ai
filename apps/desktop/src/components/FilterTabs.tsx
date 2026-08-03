/**
 * A small segmented filter — visually the app's seg-toggle, factored out
 * because two screens now need it as a value-in/value-out control (the
 * wizard's model-library fit filter here, the Library screen in U2).
 */
export interface FilterTab<V extends string> {
  value: V;
  label: string;
}

export function FilterTabs<V extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: FilterTab<V>[];
  value: V;
  onChange: (value: V) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg-toggle" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
