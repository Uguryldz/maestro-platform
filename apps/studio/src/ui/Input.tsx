import { useId } from "react";
import type { InputHTMLAttributes } from "react";
import "./Field.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  /** Already-translated label text. Omit only for inputs labelled elsewhere. */
  readonly label?: string;
  /** Already-translated hint shown under the field. */
  readonly hint?: string;
  /** Already-translated error; shows the field in red and sets aria-invalid. */
  readonly error?: string;
}

/** Mirrors `.inp` from the mock, wrapped in the shared field furniture. */
export function Input({ label, hint, error, id, ...rest }: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = error !== undefined ? `${inputId}-err` : hint !== undefined ? `${inputId}-hint` : undefined;

  return (
    <div className="ui-field">
      {label !== undefined && (
        <label className="ui-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input
        {...rest}
        id={inputId}
        className={error !== undefined ? "ui-input ui-input--error" : "ui-input"}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
      />
      {error !== undefined ? (
        <p className="ui-field__error" id={`${inputId}-err`}>
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p className="ui-field__hint" id={`${inputId}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}
