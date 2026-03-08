"use client";

import { useState } from "react";
import { api } from "@/lib/trpc-client";

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  PENDING_SETUP: "bg-yellow-100 text-yellow-800",
  PENDING_PAYMENT: "bg-orange-100 text-orange-800",
  SUSPENDED: "bg-red-100 text-red-800",
  PAST_DUE: "bg-red-100 text-red-800",
  CANCELED: "bg-gray-100 text-gray-800",
  INACTIVE: "bg-gray-100 text-gray-800",
  PAUSED: "bg-blue-100 text-blue-800",
};

const TIER_LABELS: Record<string, string> = {
  PRO: "Pro ($149/mo)",
  MULTIPLIER: "Multiplier ($499/mo)",
  ENTERPRISE: "Enterprise",
};

type StatusFilter = "ALL" | "PENDING_SETUP" | "ACTIVE" | "SUSPENDED";

export default function AdminPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const { data, isLoading, refetch } = api.admin.listOrgs.useQuery({
    statusFilter,
    limit: 50,
  });

  const setStatus = api.admin.setOnboardingStatus.useMutation({
    onSuccess: () => refetch(),
  });

  function handleToggle(orgId: string, currentStatus: string) {
    const newStatus = currentStatus === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    if (
      newStatus === "SUSPENDED" &&
      !window.confirm("Suspend this organization? They will lose dashboard access.")
    ) {
      return;
    }
    setStatus.mutate({ orgId, status: newStatus });
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage organizations, review onboarding, activate clients
            </p>
          </div>
          <div className="flex gap-2">
            {(["ALL", "PENDING_SETUP", "ACTIVE", "SUSPENDED"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  statusFilter === f
                    ? "bg-gray-900 text-white"
                    : "bg-white text-gray-700 hover:bg-gray-100"
                }`}
              >
                {f === "ALL" ? "All" : f.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-gray-500">Loading organizations...</div>
        ) : !data?.orgs.length ? (
          <div className="py-12 text-center text-gray-500">No organizations found</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Organization
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Owner
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Tier
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Subscription
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Onboarding
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Niche
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Accounts
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {data.orgs.map((org) => (
                  <tr key={org.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="font-medium text-gray-900">{org.name}</div>
                      <div className="text-xs text-gray-400">{org.slug}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                      <div>{org.ownerName}</div>
                      <div className="text-xs text-gray-400">{org.ownerEmail}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      {TIER_LABELS[org.pricingTier] ?? org.pricingTier}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_COLORS[org.subscriptionStatus] ?? "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {org.subscriptionStatus}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_COLORS[org.onboardingStatus] ?? "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {org.onboardingStatus}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                      {org.niche}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                      {org.accountCount}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {org.onboardingStatus === "PENDING_SETUP" && (
                        <button
                          onClick={() => handleToggle(org.id, org.onboardingStatus)}
                          disabled={setStatus.isPending}
                          className="rounded-md bg-green-600 px-3 py-1 text-sm font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
                        >
                          Activate
                        </button>
                      )}
                      {org.onboardingStatus === "ACTIVE" && (
                        <button
                          onClick={() => handleToggle(org.id, org.onboardingStatus)}
                          disabled={setStatus.isPending}
                          className="rounded-md bg-red-50 px-3 py-1 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                        >
                          Suspend
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {setStatus.error && (
          <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {setStatus.error.message}
          </div>
        )}
      </div>
    </div>
  );
}
