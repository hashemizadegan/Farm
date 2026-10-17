"use client";
import Link from "next/link";
import { EmptyState, Notice, PageHeader, StatusPill } from "@metafarm/ui";
import { RequireTenant } from "@/components/RequireTenant";
import { api, unwrap, useQuery } from "@/lib/api";
import { useCan } from "@/lib/can";
import { useTenant } from "@/lib/tenant";

export default function OverviewPage() {
  const { me, tenantId } = useTenant();
  const can = useCan();
  const workspace = me?.tenants.find((t) => t.tenantId === tenantId);
  return (
    <>
      <PageHeader
        title={workspace ? workspace.name : "Overview"}
        description="Your farm projects and what needs attention."
        actions={
          workspace && can("farm:write") ? (
            <Link href="/farms/new" className="mf-button mf-button--primary">
              Create a farm project
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
  const farms = useQuery(`farms:${tenantId}`, () =>
    unwrap(api.GET("/v1/tenants/{tenantId}/farms", { params: { path: { tenantId }, query: { limit: 100 } } })),
  );
  if (farms.loading && !farms.data) return <p role="status">Loading your farms…</p>;
  if (farms.error) return <Notice tone="error" title="Could not load farms.">{farms.error.message}</Notice>;
  const items = farms.data?.items ?? [];
  const withBoundary = items.filter((f) => f.currentBoundaryVersionId).length;

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          title="Start your first farm project"
        >
          {can("farm:write")
            ? "A farm project holds a boundary, a planting plan, field observations and a 3D view of the plan."
            : "No farm projects have been created in this workspace yet. Ask a manager or admin to create one."}
        </EmptyState>
        <h2>How a project comes together</h2>
        <GettingStarted farms={0} validated={0} />
      </>
    );
  }

  const recent = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  return (
    <>
      <dl className="stats">
        <div>
          <dt>Farm projects</dt>
          <dd>{items.length}</dd>
        </div>
        <div>
          <dt>With a validated boundary</dt>
          <dd>{withBoundary}</dd>
        </div>
        <div>
          <dt>Waiting for a valid boundary</dt>
          <dd>{items.length - withBoundary}</dd>
        </div>
      </dl>

      <div className="split">
        <section aria-labelledby="recent-heading">
          <div className="mf-page-header" style={{ marginBottom: "0.75rem" }}>
            <h2 id="recent-heading" style={{ margin: 0 }}>
              Recent farm projects
            </h2>
            <Link href="/farms">All farms</Link>
          </div>
          <div className="table-wrap">
            <table>
              <caption className="mf-visually-hidden">Most recently created farm projects</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Boundary</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((f) => (
                  <tr key={f.id}>
                    <th scope="row">
                      <Link href={`/farms/${f.id}`}>{f.name}</Link>
                    </th>
                    <td>{f.currentBoundaryVersionId ? <StatusPill tone="ok">Validated</StatusPill> : <StatusPill tone="pending">Needs a boundary</StatusPill>}</td>
                    <td>
                      <time dateTime={f.createdAt}>{new Date(f.createdAt).toLocaleDateString()}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section aria-labelledby="next-heading">
          <h2 id="next-heading" style={{ marginTop: 0 }}>
            Next steps
          </h2>
          <GettingStarted farms={items.length} validated={withBoundary} />
        </section>
      </div>
    </>
  );
}

/** The real order of work in a project, with the steps already done ticked. */
function GettingStarted({ farms, validated }: { farms: number; validated: number }) {
  const can = useCan();
  return (
    <ol className="steps">
      <li data-done={farms > 0 || undefined}>
        <div>
          <strong>Create a farm project</strong>
          <p>Name it and give a GPS point, a drawn outline or a GeoJSON file.</p>
        </div>
      </li>
      <li data-done={validated > 0 || undefined}>
        <div>
          <strong>Get a valid boundary</strong>
          <p>The shape is checked automatically. Fix and resubmit if it is rejected.</p>
        </div>
      </li>
      <li>
        <div>
          <strong>Plan parcels and planting grids</strong>
          <p>Set rows, columns and spacing on the farm&apos;s overview page.</p>
        </div>
      </li>
      <li>
        <div>
          <strong>{can("member:manage") ? <Link href="/team">Invite your team</Link> : "Work with your team"}</strong>
          <p>Give each person a role: manager, verifier or viewer.</p>
        </div>
      </li>
    </ol>
  );
}
