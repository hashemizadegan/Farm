import { createContext, forwardRef, useContext, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { PROVENANCE_DESCRIPTIONS, type ProvenanceLabel } from "@metafarm/domain/provenance";

/** The few strings this package renders itself; the app supplies translations. */
export interface UiText {
  errorSummaryTitle: string;
  provenance: Record<ProvenanceLabel, { short: string; long: string }>;
}
const DEFAULT_TEXT: UiText = { errorSummaryTitle: "There is a problem", provenance: PROVENANCE_DESCRIPTIONS };
const UiTextContext = createContext<UiText>(DEFAULT_TEXT);
export function UiTextProvider({ value, children }: { value: UiText; children: ReactNode }) {
  return <UiTextContext.Provider value={value}>{children}</UiTextContext.Provider>;
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="mf-visually-hidden">{children}</span>;
}

export function SkipLink({ href = "#main", children = "Skip to main content" }: { href?: string; children?: ReactNode }) {
  return (
    <a className="mf-skip-link" href={href}>
      {children}
    </a>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger"; busy?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", busy, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`mf-button mf-button--${variant}`}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {children}
    </button>
  );
});

interface FieldBase {
  label: string;
  hint?: string;
  error?: string;
}

export const TextField = forwardRef<HTMLInputElement, FieldBase & InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { label, hint, error, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className="mf-field">
      <label htmlFor={inputId}>
        {label}
        {rest.required && <span aria-hidden="true"> *</span>}
      </label>
      {hint && (
        <p id={hintId} className="mf-hint">
          {hint}
        </p>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        {...rest}
      />
      {error && (
        <p id={errorId} className="mf-error">
          {error}
        </p>
      )}
    </div>
  );
});

export function SelectField({ label, hint, error, id, children, ...rest }: FieldBase & SelectHTMLAttributes<HTMLSelectElement>) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  return (
    <div className="mf-field">
      <label htmlFor={selectId}>{label}</label>
      {hint && (
        <p id={hintId} className="mf-hint">
          {hint}
        </p>
      )}
      <select id={selectId} aria-invalid={error ? true : undefined} aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined} {...rest}>
        {children}
      </select>
      {error && (
        <p id={errorId} className="mf-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Provenance is conveyed by text, not colour alone (WCAG 1.4.1). */
export function ProvenanceBadge({ label }: { label: ProvenanceLabel }) {
  const d = useContext(UiTextContext).provenance[label];
  return (
    <span className={`mf-badge mf-badge--${label}`} title={d.long}>
      {d.short}
      <VisuallyHidden>: {d.long}</VisuallyHidden>
    </span>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: "info" | "warning" | "error"; title?: string; children: ReactNode }) {
  return (
    <div className={`mf-notice mf-notice--${tone}`} role={tone === "error" ? "alert" : "note"}>
      {title && <strong>{title} </strong>}
      {children}
    </div>
  );
}

export function ErrorSummary({ errors, title }: { errors: { field?: string; message: string }[]; title?: string }) {
  const text = useContext(UiTextContext);
  if (errors.length === 0) return null;
  title ??= text.errorSummaryTitle;
  return (
    // tabIndex -1 lets the page move focus here after a failed submit.
    <div className="mf-error-summary" role="alert" tabIndex={-1} data-error-summary>
      <h2>{title}</h2>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>{e.field ? <a href={`#${e.field}`}>{e.message}</a> : e.message}</li>
        ))}
      </ul>
    </div>
  );
}

/** Page title row: heading, optional one-line description, and actions aligned to the end. */
export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mf-page-header">
      <div className="mf-page-header__text">
        <h1>{title}</h1>
        {description && <p className="mf-page-header__desc">{description}</p>}
        {children}
      </div>
      {actions && <div className="mf-page-header__actions">{actions}</div>}
    </div>
  );
}

/** Short status with a shape marker so meaning never rests on colour alone (WCAG 1.4.1). */
export function StatusPill({ tone, children }: { tone: "ok" | "pending" | "problem" | "neutral"; children: ReactNode }) {
  const marker = { ok: "●", pending: "◐", problem: "▲", neutral: "○" }[tone];
  return (
    <span className={`mf-pill mf-pill--${tone}`}>
      <span aria-hidden="true" className="mf-pill__marker">
        {marker}
      </span>
      {children}
    </span>
  );
}

/** An empty state that says what to do next. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mf-empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
