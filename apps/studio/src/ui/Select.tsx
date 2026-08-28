import { useId } from "react";
import type { SelectHTMLAttributes } from "react";
import "./Field.css";

export interface SelectOption {
  readonly value: string;
  /** Already-translated option text. */
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children"> {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly options: readonly SelectOption[];
}

/** Mirrors `.sel` from the mock. */
export function Select({ label, hint, error, options, id, ...rest }: SelectProps) {
  const generated = useId();
  const selectId = id ?? generated;
  const describedBy = error !== undefined ? `${selectId}-err` : hint !== undefined ? `${selectId}-hint` : undefined;

  return (
    <div className="ui-field">
      {label !== undefined && (
        <label className="ui-field__label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <select
        {...rest}
        id={selectId}
        className={error !== undefined ? "ui-input ui-input--error" : "ui-input"}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error !== undefined ? (
        <p className="ui-field__error" id={`${selectId}-err`}>
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p className="ui-field__hint" id={`${selectId}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}
