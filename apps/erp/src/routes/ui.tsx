import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { RequestLogEntry, UserRole } from "@sync/db/schema";
import { readChaos, setChaos } from "../lib/chaos.ts";
import type { AppBindings } from "../lib/middleware.ts";
import { csrfProtect, requireAdmin, sessionAuth } from "../lib/middleware.ts";
import { cancelOrder, listOrders, listStock } from "../lib/orders.ts";
import { listRequestLog } from "../lib/request-log.ts";
import { serializeOrder, type SerializedOrder } from "../lib/serialize.ts";
import { chaosPatchSchema } from "../lib/validation.ts";
import { Layout, OutcomeTag, StatusTag, Topbar } from "../ui/layout.tsx";
import type { Env } from "../env.ts";

function csrfToken(c: Context<AppBindings>): string {
  let token = getCookie(c, "erp.csrf");
  if (!token) {
    token = randomUUID();
    setCookie(c, "erp.csrf", token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    });
  }
  return token;
}

/** Read once, on first render. */
let cachedCss: string | undefined;
function bootstrapCss(): string {
  cachedCss ??= readFileSync(
    createRequire(import.meta.url).resolve("bootstrap/dist/css/bootstrap.min.css"),
    "utf8",
  );
  return cachedCss;
}

export function uiRoutes(env: Env) {
  const ui = new Hono<AppBindings>();

  ui.get("/assets/bootstrap.min.css", (c) => {
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(bootstrapCss(), 200, { "Content-Type": "text/css; charset=utf-8" });
  });

  ui.get("/login", (c) => {
    const token = csrfToken(c);
    const error = c.req.query("error");
    return c.html(
      <Layout title="Mini-ERP — sign in">
        <div class="card mx-auto mt-5" style="max-width:400px">
          <div class="card-body">
            <h1 class="h4 mb-1">Mini-ERP</h1>
            <p class="fg-secondary small mb-4">
              Internal tool. Accounts are created by the seed script.
            </p>
            <form method="post" action="/login">
              <input type="hidden" name="_csrf" value={token} />
              <div class="mb-3">
                <label class="form-label" for="email">
                  Email
                </label>
                <input
                  class="form-control"
                  id="email"
                  name="email"
                  type="email"
                  autocomplete="username"
                  required
                />
              </div>
              <div class="mb-3">
                <label class="form-label" for="password">
                  Password
                </label>
                <input
                  class="form-control"
                  id="password"
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  required
                />
              </div>
              {error ? <div class="alert theme-danger mb-3">Invalid credentials.</div> : null}
              <button class="btn btn-solid theme-primary w-100" type="submit">
                Sign in
              </button>
            </form>
          </div>
        </div>
      </Layout>,
    );
  });

  ui.post("/login", csrfProtect, async (c) => {
    const form = await c.req.formData();
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    const response = await c.get("auth").api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    if (!response.ok) return c.redirect("/login?error=1", 303);
    const cookie = response.headers.get("set-cookie");
    if (cookie) c.header("set-cookie", cookie, { append: true });
    return c.redirect("/", 303);
  });

  ui.post("/logout", csrfProtect, async (c) => {
    const response = await c
      .get("auth")
      .api.signOut({ headers: c.req.raw.headers, asResponse: true });
    const cookie = response.headers.get("set-cookie");
    if (cookie) c.header("set-cookie", cookie, { append: true });
    return c.redirect("/login", 303);
  });

  ui.use("/", sessionAuth({ require: false }));
  ui.get("/", async (c) => {
    const role = c.get("role");
    if (!role) return c.redirect("/login", 302);
    const db = c.get("db");
    const token = csrfToken(c);
    const [orders, stockRows, chaos] = await Promise.all([
      listOrders(db, { limit: 50 }),
      listStock(db),
      readChaos(db),
    ]);
    // Every order goes through serializeOrder before reaching the view.
    const serialized = orders.map((o) => serializeOrder(o, role, env.DEMO_PSEUDONYM_SECRET));
    return c.html(
      <Dashboard
        role={role}
        email={c.get("userEmail") ?? ""}
        orders={serialized}
        stock={stockRows}
        chaos={chaos}
        csrf={token}
      />,
    );
  });

  /**
   * Machine call log. Visible to both roles: it holds no customer data, only
   * keys, status codes and durations.
   */
  ui.use("/request-log", sessionAuth({ require: false }));
  ui.get("/request-log", async (c) => {
    const role = c.get("role");
    if (!role) return c.redirect("/login", 302);
    const key = c.req.query("key") || undefined;
    const entries = await listRequestLog(c.get("db"), {
      limit: 100,
      ...(key ? { idempotencyKey: key } : {}),
    });
    return c.html(
      <RequestLogPage
        role={role}
        email={c.get("userEmail") ?? ""}
        csrf={csrfToken(c)}
        entries={entries}
        filterKey={key}
      />,
    );
  });

  ui.use("/chaos", sessionAuth(), requireAdmin);
  ui.post("/chaos", csrfProtect, async (c) => {
    const form = await c.req.formData();
    const parsed = chaosPatchSchema.safeParse({
      enabled: form.get("enabled") === "on",
      failureRate: form.get("failureRate") ?? undefined,
      latencyMs: form.get("latencyMs") ?? undefined,
      lostResponseRate: form.get("lostResponseRate") ?? undefined,
      throttleRate: form.get("throttleRate") ?? undefined,
    });
    if (parsed.success) {
      await setChaos(c.get("db"), {
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled ? 1 : 0 } : {}),
        ...(parsed.data.failureRate !== undefined ? { failureRate: parsed.data.failureRate } : {}),
        ...(parsed.data.latencyMs !== undefined ? { latencyMs: parsed.data.latencyMs } : {}),
        ...(parsed.data.lostResponseRate !== undefined
          ? { lostResponseRate: parsed.data.lostResponseRate }
          : {}),
        ...(parsed.data.throttleRate !== undefined ? { throttleRate: parsed.data.throttleRate } : {}),
      });
    }
    return c.redirect("/", 303);
  });

  ui.use("/orders/:id/cancel", sessionAuth(), requireAdmin);
  ui.post("/orders/:id/cancel", csrfProtect, async (c) => {
    await cancelOrder(c.get("db"), c.req.param("id"));
    return c.redirect("/", 303);
  });

  return ui;
}

type DashboardProps = {
  role: UserRole;
  email: string;
  orders: SerializedOrder[];
  stock: { sku: string; title: string; quantity: number }[];
  chaos: { enabled: number; failureRate: number; latencyMs: number; lostResponseRate: number; throttleRate: number };
  csrf: string;
};

function Dashboard({ role, email, orders, stock, chaos, csrf }: DashboardProps) {
  return (
    <Layout title="Mini-ERP">
      <Topbar role={role} email={email} csrf={csrf} active="dashboard" />

      {role === "admin" ? <ChaosForm chaos={chaos} csrf={csrf} /> : null}

      <h2 class="h5 mb-3">
        Orders <span class="fg-secondary small">({orders.length})</span>
      </h2>
      <div class="card mb-4">
        <table class="table table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>ERP ID</th>
              <th>Shopify ref.</th>
              <th>Customer</th>
              <th>Pseudonym</th>
              <th>Total</th>
              <th>Status</th>
              {role === "admin" ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colspan={role === "admin" ? 7 : 6} class="fg-secondary">
                  No orders received yet.
                </td>
              </tr>
            ) : (
              orders.map((order) => (
                <tr key={order.id}>
                  <td class="font-monospace small">{order.id}</td>
                  <td class="font-monospace small">{order.externalReference}</td>
                  <td>
                    {order.customer.name}
                    <div class="fg-secondary small">{order.customer.email}</div>
                  </td>
                  <td class="font-monospace small">{order.customer.pseudonym}</td>
                  <td>
                    {order.total} {order.currency}
                  </td>
                  <td>
                    <StatusTag status={order.status} />
                  </td>
                  {role === "admin" ? (
                    <td class="text-end">
                      {order.status === "received" ? (
                        <form method="post" action={`/orders/${order.id}/cancel`}>
                          <input type="hidden" name="_csrf" value={csrf} />
                          <button class="btn btn-sm btn-outline theme-danger" type="submit">
                            Cancel
                          </button>
                        </form>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 class="h5 mb-3">Stock</h2>
      <div class="card">
        <table class="table table-sm mb-0">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Item</th>
              <th class="text-end">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {stock.map((row) => (
              <tr key={row.sku}>
                <td class="font-monospace small">{row.sku}</td>
                <td>{row.title}</td>
                <td class={`text-end${row.quantity <= 2 ? " fg-danger fw-semibold" : ""}`}>
                  {row.quantity}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

function ChaosForm({ chaos, csrf }: Pick<DashboardProps, "chaos" | "csrf">) {
  const field = (name: string, label: string, value: number, unit: string) => (
    <div class="input-group" style="width:auto">
      <span class="input-group-text">{label}</span>
      <input class="form-control" name={name} value={String(value)} style="width:80px" />
      <span class="input-group-text">{unit}</span>
    </div>
  );
  return (
    <div class="card mb-4">
      <div class="card-header fw-semibold">Chaos mode</div>
      <div class="card-body">
        <form method="post" action="/chaos" class="d-flex flex-wrap align-items-center gap-3">
          <input type="hidden" name="_csrf" value={csrf} />
          <div class="d-flex align-items-center gap-2">
            <div class="switch theme-danger">
              <input
                type="checkbox"
                id="chaos-enabled"
                name="enabled"
                {...(chaos.enabled ? { checked: true } : {})}
              />
            </div>
            <label for="chaos-enabled">enabled</label>
          </div>
          {field("failureRate", "503", chaos.failureRate, "%")}
          {field("latencyMs", "latency", chaos.latencyMs, "ms")}
          {field("lostResponseRate", "lost response", chaos.lostResponseRate, "%")}
          {field("throttleRate", "429", chaos.throttleRate, "%")}
          <button class="btn btn-solid theme-primary" type="submit">
            Apply
          </button>
        </form>
      </div>
    </div>
  );
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Paris",
});

function RequestLogPage({
  role,
  email,
  csrf,
  entries,
  filterKey,
}: {
  role: UserRole;
  email: string;
  csrf: string;
  entries: RequestLogEntry[];
  filterKey: string | undefined;
}) {
  return (
    <Layout title="Mini-ERP — request log" refreshSeconds={3}>
      <Topbar role={role} email={email} csrf={csrf} active="request-log" />

      <p class="fg-secondary">
        The last 100 API calls from the app and the worker, newest first. Refreshed every
        3 seconds. Click an idempotency key to follow an order across its attempts.
      </p>

      {filterKey ? (
        <div class="alert theme-info mb-3 d-flex justify-content-between align-items-center">
          <span>
            Filtered on key <span class="font-monospace">{filterKey}</span>
          </span>
          <a class="btn btn-sm btn-outline theme-secondary" href="/request-log">
            Show all
          </a>
        </div>
      ) : null}

      <div class="card">
        <table class="table table-sm table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>Time</th>
              <th>Request</th>
              <th>Idempotency key</th>
              <th>HTTP</th>
              <th>Outcome</th>
              <th>Code</th>
              <th class="text-end">Duration</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colspan={7} class="fg-secondary">
                  No calls yet. Run <code>npm run demo -- --chaos</code>.
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id}>
                  <td class="font-monospace small">{timeFormat.format(e.createdAt)}</td>
                  <td class="font-monospace small">
                    {e.method} {e.path}
                  </td>
                  <td class="font-monospace small">
                    {e.idempotencyKey ? (
                      <a href={`/request-log?key=${encodeURIComponent(e.idempotencyKey)}`}>
                        {e.idempotencyKey}
                      </a>
                    ) : (
                      <span class="fg-secondary">—</span>
                    )}
                  </td>
                  <td class="font-monospace small">{e.status}</td>
                  <td>
                    <OutcomeTag outcome={e.outcome} />
                  </td>
                  <td class="font-monospace small fg-secondary">{e.errorCode ?? ""}</td>
                  <td class="text-end small">{e.durationMs} ms</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}
