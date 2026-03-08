"use client";

import { api } from "@/lib/trpc-client";

const TIER_STYLES: Record<number, string> = {
  1: "bg-purple-100 text-purple-800",
  2: "bg-blue-100 text-blue-800",
  3: "bg-gray-100 text-gray-800",
};

const TIER_LABELS: Record<number, string> = {
  1: "Tier 1 — Orchestrator",
  2: "Tier 2 — Platform",
  3: "Tier 3 — Utility",
};

export default function AgentsPage() {
  const { data: agents, isLoading } = api.agents.list.useQuery();

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
          <p className="mt-1 text-sm text-gray-500">
            All registered agents in the Mastra hierarchy
          </p>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-gray-500">
            Loading agents...
          </div>
        ) : !agents?.length ? (
          <div className="py-12 text-center text-gray-500">
            No agents registered.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <div
                key={agent.name}
                className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-medium text-gray-900">
                    {agent.name}
                  </span>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      TIER_STYLES[agent.tier] ?? "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {TIER_LABELS[agent.tier] ?? `Tier ${agent.tier}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
