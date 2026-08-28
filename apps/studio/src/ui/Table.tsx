import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState.tsx";
import { Skeleton } from "./Skeleton.tsx";
import "./Table.css";

export interface Column<Row> {
  /** Stable identity for the column; also the React key. */
  readonly key: string;
  /** Already-translated header text. */
  readonly header: string;
  /** Cell renderer. Return a string or any node. */
  readonly cell: (row: Row) => ReactNode;
  /** Right-align numerics. */
  readonly align?: "left" | "right";
  readonly width?: string;
}

export interface TableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  /** Stable row identity — required, so React never keys on the index. */
  readonly rowKey: (row: Row) => string;
  /** Makes rows clickable (hover + pointer + keyboard activation). */
  readonly onRowClick?: (row: Row) => void;
  readonly loading?: boolean;
  /** Already-translated text shown when `rows` is empty. */
  readonly emptyLabel: string;
  /** Already-translated caption for screen readers. */
  readonly caption?: string;
}

/**
 * Mirrors the mock's bare `table` styling plus `.click` rows and `.scroll`.
 * Handles its own loading and empty states so every list screen behaves alike.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  emptyLabel,
  caption,
}: TableProps<Row>) {
  if (loading) return <Skeleton rows={5} />;
  if (rows.length === 0) return <EmptyState title={emptyLabel} />;

  return (
    <div className="ui-table-scroll">
      <table className="ui-table">
        {caption !== undefined && <caption className="ui-table__caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{
                  ...(column.align === "right" ? { textAlign: "right" as const } : {}),
                  ...(column.width !== undefined ? { width: column.width } : {}),
                }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? "ui-table__row--click" : undefined}
              {...(onRowClick
                ? {
                    onClick: () => onRowClick(row),
                    tabIndex: 0,
                    role: "button",
                    onKeyDown: (event: React.KeyboardEvent) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    },
                  }
                : {})}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={column.align === "right" ? { textAlign: "right" } : undefined}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
