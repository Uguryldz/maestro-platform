import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

export type ButtonVariant = "default" | "primary" | "success" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Renders a spinner-ish disabled state; the label stays put to avoid layout jump. */
  readonly busy?: boolean;
  readonly children: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "ui-btn--primary",
  success: "ui-btn--success",
  danger: "ui-btn--danger",
};

/**
 * The only button in the Studio. Mirrors `.btn` / `.btn.p` / `.btn.g` / `.btn.d`
 * from the mock. Labels must come from the catalog — pass an already-translated
 * string, never a literal.
 */
export function Button({
  variant = "default",
  size = "md",
  busy = false,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const classes = ["ui-btn", VARIANT_CLASS[variant], size === "sm" ? "ui-btn--sm" : ""]
    .filter((c) => c !== "")
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}
