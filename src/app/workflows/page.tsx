"use client";

import { api } from "@/lib/trpc-client";

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED: "bg-yellow-100 text-yellow-800",
  PUBLISHED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
  DRAFT: "bg-gray-100 text-gray-800",
};

export default function WorkflowsPage() {
  const { data: workflows, isLoading: loadingWorkflows } =
    api.workflows.list.useQuery();

  const { data: history, isLoading: loadingHistory } =
    api.workflows.runHistory.useQuery({ limit: 25 });

  const runNow = api.workflows.runNow.useMutation();

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Workflows</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage and run your content workflows
          </p>
        </div>

        {/* Workflow Definitions */}
        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">
            Workflow Definitions
          </h2>
          {loadingWorkflows ? (
            <div className="py-8 text-center text-gray-500">
              Loading workflows...
            </div>
          ) : !workflows?.length ? (
            <div className="py-8 text-center text-gray-500">
              No workflows found. Add YAML files to your workflows directory.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {workflows.map((wf) => (
                <div
                  key={wf.name}
                  className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-medium text-gray-900">
                        {wf.name}
                      </h3>
                      {wf.description && (
                        <p className="mt-1 text-sm text-gray-500">
                          {wf.description}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-700">
                          {wf.trigger.type}
                        </span>
                        {wf.trigger.schedule && (
                          <span className="font-mono">{wf.trigger.schedule}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => runNow.mutate({ workflowName: wf.name })}
                    disabled={runNow.isPending}
                    className="mt-3 w-full rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-50"
                  >
                    {runNow.isPending ? "Queuing..." : "Run Now"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {runNow.error && (
            <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
              {runNow.error.message}
            </div>
          )}
          {runNow.isSuccess && (
            <div className="mt-4 rounded-md bg-green-50 p-3 text-sm text-green-700">
              Queued &ldquo;{runNow.data.workflowName}&rdquo; successfully
            </div>
          )}
        </section>

        {/* Run History */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-gray-900">
            Run History
          </h2>
          {loadingHistory ? (
            <div className="py-8 text-center text-gray-500">
              Loading history...
            </div>
          ) : !history?.records.length ? (
            <div className="py-8 text-center text-gray-500">
              No run history yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Platform</th>
                    <th className="px-4 py-3">Scheduled</th>
                    <th className="px-4 py-3">Posted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {history.records.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                            STATUS_COLORS[r.status] ?? "bg-gray-100 text-gray-800"
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-gray-700">{r.platform}</td>
                      <td className="px-4 py-2 text-gray-500">
                        {new Date(r.scheduledAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-gray-500">
                        {r.postedAt
                          ? new Date(r.postedAt).toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
