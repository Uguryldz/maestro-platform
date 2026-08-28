import "./Skeleton.css";

export interface SkeletonProps {
  /** Number of shimmer lines. */
  readonly rows?: number;
  /** Width of the last line, so blocks do not look artificially even. */
  readonly lastWidth?: string;
}

/**
 * Loading placeholder. Carries no text, so it needs no catalog key; it is
 * announced as busy for assistive tech instead.
 */
export function Skeleton({ rows = 3, lastWidth = "60%" }: SkeletonProps) {
  return (
    <div className="ui-skeleton" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="ui-skeleton__line"
          style={index === rows - 1 ? { width: lastWidth } : undefined}
        />
      ))}
    </div>
  );
}
