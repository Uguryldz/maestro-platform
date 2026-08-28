import { useId } from "react";
import type { TextareaHTMLAttributes } from "react";
import "../../ui/Field.css";

/**
 * Multi-line counterpart to the shared <Input>. It lives here rather than in
 * src/ui because only this cluster needs it (AI instructions, few-shot examples,
 * document notes); if a second cluster wants it, promote this file to src/ui.
 *
 * It reuses ui/Field.css and the same id-wiring rules, so label/hint/error
 * behave exactly like <Input> and getByLabelText works in tests.
 */
export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  /** Already-translated label text. */
  readonly label?: string;
  /** Already-translated hint shown under the field. */
  readonly hint?: string;
  /** Already-translated error; shows the field in red and sets aria-invalid. */
  readonly error?: string;
}

export function TextArea({ label, hint, error, id, rows = 4, ...rest }: TextAreaProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const describedBy =
    error !== undefined ? `${fieldId}-err` : hint !== undefined ? `${fieldId}-hint` : undefined;

  return (
    <div className="ui-field">
      {label !== undefined && (
        <label className="ui-field__label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <textarea
        {...rest}
        id={fieldId}
        rows={rows}
        className={error !== undefined ? "ui-input ui-input--error" : "ui-input"}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
      />
      {error !== undefined ? (
        <p className="ui-field__error" id={`${fieldId}-err`}>
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p className="ui-field__hint" id={`${fieldId}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  );
}
