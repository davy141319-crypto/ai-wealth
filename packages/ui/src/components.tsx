/** Tiny shared UI components for P0 (expanded in later phases). */

export interface LoadingProps {
  label?: string;
}

/** Accessible loading indicator placeholder. */
export function Loading({ label = 'Loading…' }: LoadingProps): JSX.Element {
  return (
    <div role="status" aria-live="polite" style={{ padding: 16 }}>
      {label}
    </div>
  );
}

export interface BrandMarkProps {
  title: string;
  subtitle?: string;
}

/** App brand mark used by web & admin. */
export function BrandMark({ title, subtitle }: BrandMarkProps): JSX.Element {
  return (
    <div>
      <strong>{title}</strong>
      {subtitle ? <span> · {subtitle}</span> : null}
    </div>
  );
}
