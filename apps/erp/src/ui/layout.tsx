import type { FC, PropsWithChildren } from "hono/jsx";
import type { RequestOutcome, UserRole } from "@sync/db/schema";

/**
 * Bootstrap 6 (alpha), served from node_modules at /assets/bootstrap.min.css:
 * no CDN, no build step. Color variants use a `theme-*` class combined with
 * the component (`btn btn-solid theme-primary`).
 */
export const Layout: FC<PropsWithChildren<{ title: string; refreshSeconds?: number }>> = ({
  title,
  refreshSeconds,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {refreshSeconds ? <meta http-equiv="refresh" content={String(refreshSeconds)} /> : null}
      <title>{title}</title>
      <link rel="stylesheet" href="/assets/bootstrap.min.css" />
    </head>
    <body>
      <main class="container py-4">{children}</main>
    </body>
  </html>
);

export const Topbar: FC<{
  role: UserRole;
  email: string;
  csrf: string;
  active: "dashboard" | "request-log";
}> = ({ role, email, csrf, active }) => (
  <>
    <div class="d-flex justify-content-between align-items-center mb-3">
      <div>
        <h1 class="h3 mb-1">Mini-ERP</h1>
        <p class="fg-secondary small mb-0">
          Signed in as <span class="badge badge-subtle theme-secondary">{role}</span> ({email})
        </p>
      </div>
      <form method="post" action="/logout">
        <input type="hidden" name="_csrf" value={csrf} />
        <button class="btn btn-outline theme-secondary" type="submit">
          Sign out
        </button>
      </form>
    </div>
    <ul class="nav nav-tabs mb-4">
      <li class="nav-item">
        <a class={`nav-link${active === "dashboard" ? " active" : ""}`} href="/">
          Orders and stock
        </a>
      </li>
      <li class="nav-item">
        <a class={`nav-link${active === "request-log" ? " active" : ""}`} href="/request-log">
          Request log
        </a>
      </li>
    </ul>
    {role === "demo" ? <DemoBanner /> : null}
  </>
);

export const DemoBanner: FC = () => (
  <div class="alert theme-warning mb-4">Demo account: masked data (read-only)</div>
);

const statusThemes: Record<string, string> = {
  received: "primary",
  shipped: "success",
  cancelled: "danger",
};

const statusLabels: Record<string, string> = {
  received: "received",
  shipped: "shipped",
  cancelled: "cancelled",
};

export const StatusTag: FC<{ status: string }> = ({ status }) => (
  <span class={`badge badge-subtle theme-${statusThemes[status] ?? "secondary"}`}>
    {statusLabels[status] ?? status}
  </span>
);

const outcomes: Record<RequestOutcome, { label: string; theme: string }> = {
  created: { label: "created", theme: "success" },
  replayed: { label: "replayed (idempotency)", theme: "info" },
  lost_response: { label: "stored, response lost", theme: "warning" },
  unavailable: { label: "unavailable", theme: "danger" },
  throttled: { label: "throttled (429)", theme: "warning" },
  rejected: { label: "rejected", theme: "danger" },
  ok: { label: "ok", theme: "secondary" },
  error: { label: "internal error", theme: "danger" },
};

export const OutcomeTag: FC<{ outcome: RequestOutcome }> = ({ outcome }) => {
  const { label, theme } = outcomes[outcome] ?? { label: outcome, theme: "secondary" };
  return <span class={`badge badge-subtle theme-${theme}`}>{label}</span>;
};
