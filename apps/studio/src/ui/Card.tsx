import type { ReactNode } from "react";
import "./Card.css";

export interface CardProps {
  /** Already-translated heading. Omit for a card with no header strip. */
  readonly title?: string;
  /** Already-translated sub-heading beside the title. */
  readonly subtitle?: string;
  /** Right-aligned header slot: buttons, tags, links. */
  readonly actions?: ReactNode;
  /** Set false when the body supplies its own padding (e.g. a full-bleed Table). */
  readonly padded?: boolean;
  readonly children: ReactNode;
}

/** Mirrors `.card` / `.card .hd` / `.card .bd` from the mock. */
export function Card({ title, subtitle, actions, padded = true, children }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section className="ui-card">
      {hasHeader && (
        <header className="ui-card__hd">
          {title !== undefined && <h3>{title}</h3>}
          {subtitle !== undefined && <span className="ui-card__sub">{subtitle}</span>}
          {actions !== undefined && <div className="ui-card__actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? "ui-card__bd" : ""}>{children}</div>
    </section>
  );
}

export interface KpiProps {
  /** Already-translated metric label. */
  readonly label: string;
  readonly value: string;
  /** Already-translated footnote under the number. */
  readonly note?: string;
}

/** The dashboard stat tile (`.card.kpi` in the mock). */
export function Kpi({ label, value, note }: KpiProps) {
  return (
    <section className="ui-card ui-kpi">
      <div className="ui-kpi__lbl">{label}</div>
      <div className="ui-kpi__val">{value}</div>
      {note !== undefined && <div className="ui-kpi__note">{note}</div>}
    </section>
  );
}
