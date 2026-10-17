"use client";
import Link from "next/link";
import { EmptyState, Notice, PageHeader } from "@metafarm/ui";
import { PlotOutline } from "@/components/PlotOutline";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useTenant } from "@/lib/tenant";
import { useI18n } from "@/i18n/provider";
import { groupTasks } from "@/components/Tasks";

export default function OverviewPage() {
  const { me, tenantId } = useTenant();
  const can = useCan();
  const workspace = me?.tenants.find((t) => t.tenantId === tenantId);
  const { m } = useI18n();
  return (
    <>
      <PageHeader
        title={workspace ? workspace.name : m.overview.title}
        description={m.overview.description}
        actions={
          workspace && can("farm:write") ? (
            <Link href="/farms/new" className="mf-button mf-button--primary">
              {m.overview.createFarm}
            </Link>
          ) : undefined
        }
      />
      <RequireTenant>{(id) => <Overview tenantId={id} />}</RequireTenant>
    </>
  );
}

function Overview({ tenantId }: { tenantId: string }) {
  const can = useCan();
  const { m, fmt } = useI18n();
  const t = m.overview;
  const farms = useQuery(`farms:${tenantId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100 } } })),
  );
  if (farms.loading && !farms.data) return <p role="status">{t.loading}</p>;
  if (farms.error) return <Notice tone="error" title={t.couldNotLoad}>{farms.error.message}</Notice>;
  const items = farms.data?.items ?? [];
  const withBoundary = items.filter((f) => f.currentBoundaryVersionId).length;

  if (items.length === 0) {
    return (
      <>
        <EmptyState title={t.emptyTitle}>{can("farm:write") ? t.emptyWriter : t.emptyReader}</EmptyState>
        <h2>{t.howHeading}</h2>
        <GettingStarted farms={0} validated={0} />
      </>
    );
  }

  const recent = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  return (
    <>
      <dl className="stats">
        <div>
          <dt>{t.statFarms}</dt>
          <dd>{fmt.number(items.length)}</dd>
        </div>
        <div>
          <dt>{t.statValidated}</dt>
          <dd>{fmt.number(withBoundary)}</dd>
        </div>
        <div>
          <dt>{t.statWaiting}</dt>
          <dd>{fmt.number(items.length - withBoundary)}</dd>
        </div>
      </dl>

      <TodayWork tenantId={tenantId} />

      <div className="split">
        <section aria-labelledby="recent-heading">
          <div className="mf-page-header" style={{ marginBottom: "0.75rem" }}>
            <h2 id="recent-heading" style={{ margin: 0 }}>
              {t.recentHeading}
            </h2>
            <Link href="/farms">{t.allFarms}</Link>
          </div>
          <ul className="plots">
            {recent.map((f) => (
              <li key={f.id}>
                <PlotOutline outline={f.outline} size={120} />
                <div>
                  <p className="plots__name">
                    <Link href={`/farms/${f.id}`}>{f.name}</Link>
                  </p>
                  <p className="plots__meta">{f.boundaryAreaM2 != null ? t.areaValidated(fmt.ha(f.boundaryAreaM2)) : t.noBoundary}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="next-heading">
          <h2 id="next-heading" style={{ marginTop: 0 }}>
            {t.nextHeading}
          </h2>
          <GettingStarted farms={items.length} validated={withBoundary} />
        </section>
      </div>
    </>
  );
}

/** Open field work at a glance: the whole team's for managers, one's own otherwise. */
function TodayWork({ tenantId }: { tenantId: string }) {
  const can = useCan();
  const { m } = useI18n();
  const t = m.tasks.today;
  const team = can("task:manage");
  const tasks = useQuery(`today-work:${tenantId}:${team}`, () =>
    unwrap(
      api.GET("/v1/tenants/{tenantId}/tasks", {
        params: { path: { tenantId }, query: { status: "open", limit: 500, ...(team ? {} : { assignee: "me" }) } },
      }),
    ),
  );
  const stock = useQuery(`inventory:${tenantId}:dashboard`, () => unwrap(api.GET("/v1/tenants/{tenantId}/inventory/items", { params: { path: { tenantId } } })));
  if (!tasks.data) return null;
  const g = groupTasks(tasks.data.items);
  const low = (stock.data?.items ?? []).filter((i) => i.lowStock || Number(i.onHand) < 0).length;
  return (
    <section className="card today-work" aria-labelledby="today-work-heading">
      <h2 id="today-work-heading">{t.heading}</h2>
      <ul className="today-work__counts">
        <li data-tone={g.overdue.length ? "problem" : undefined}>{t.overdue(g.overdue.length)}</li>
        <li>{t.dueToday(g.today.length)}</li>
        <li>{t.upcoming(g.upcoming.length)}</li>
      </ul>
      {low > 0 && (
        <p className="today-work__stock">
          <Link href="/inventory">{m.inventory.lowStockN(low)}</Link>
        </p>
      )}
      <p className="today-work__links">
        <Link href="/tasks">{t.mine}</Link>
        <Link href="/schedule">{t.schedule}</Link>
      </p>
    </section>
  );
}

/** The real order of work in a project, with the steps already done ticked. */
function GettingStarted({ farms, validated }: { farms: number; validated: number }) {
  const can = useCan();
  const s = useI18n().m.overview.steps;
  return (
    <ol className="steps">
      <li data-done={farms > 0 || undefined}>
        <div>
          <strong>{s.create.title}</strong>
          <p>{s.create.text}</p>
        </div>
      </li>
      <li data-done={validated > 0 || undefined}>
        <div>
          <strong>{s.boundary.title}</strong>
          <p>{s.boundary.text}</p>
        </div>
      </li>
      <li>
        <div>
          <strong>{s.plan.title}</strong>
          <p>{s.plan.text}</p>
        </div>
      </li>
      <li>
        <div>
          <strong>{can("member:manage") ? <Link href="/team">{s.team.title}</Link> : s.team.titleReader}</strong>
          <p>{s.team.text}</p>
        </div>
      </li>
    </ol>
  );
}
