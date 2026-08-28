import type { ReactNode } from "react";
import "./Tabs.css";

export interface TabItem {
  readonly id: string;
  /** Already-translated tab label. */
  readonly label: string;
  readonly count?: number;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly onChange: (id: string) => void;
  /** Already-translated accessible name for the tab strip. */
  readonly label: string;
}

/**
 * Mirrors `.tabs` / `.tab` from the mock. Controlled: the screen owns which tab
 * is active, so it can put that in the URL if it wants deep links.
 */
export function Tabs({ items, active, onChange, label }: TabsProps): ReactNode {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`panel-${item.id}`}
            className={selected ? "ui-tab ui-tab--active" : "ui-tab"}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.count !== undefined && <span className="ui-tab__cnt">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  readonly id: string;
  readonly active: string;
  readonly children: ReactNode;
}

/** Pairs with <Tabs>; renders nothing unless its id is the active one. */
export function TabPanel({ id, active, children }: TabPanelProps): ReactNode {
  if (id !== active) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>
      {children}
    </div>
  );
}
