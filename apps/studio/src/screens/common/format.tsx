import type { ReactNode } from "react";
import "./screens.css";

export interface KeyValueEntry {
  /** Already-translated label. */
  readonly label: string;
  readonly value: ReactNode;
}

export interface KeyValueProps {
  readonly entries: readonly KeyValueEntry[];
}

/** The mock's `.kv` block as a real definition list. */
export function KeyValue({ entries }: KeyValueProps): ReactNode {
  return (
    <dl className="scr-kv">
      {entries.map((entry) => (
        <div key={entry.label} style={{ display: "contents" }}>
          <dt>{entry.label}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
