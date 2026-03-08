"use client";

import { useState } from "react";
import { api } from "@/lib/trpc-client";

const CIRCUIT_COLORS: Record<string, string> = {
  CLOSED: "bg-green-100 text-green-800",
  HALF_OPEN: "bg-yellow-100 text-yellow-800",
  OPEN: "bg-red-100 text-red-800",
};

export default function SettingsPage() {
  const org = api.settings.getOrgDetails.useQuery();
  const tokens = api.settings.listPlatformTokens.useQuery();
  const utils = api.useUtils();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [brandJson, setBrandJson] = useState("");
  const [nameInitialized, setNameInitialized] = useState(false);

  // Initialize form state from fetched data
  if (org.data && !nameInitialized) {
    setName(org.data.name);
    setSlug(org.data.slug);
    setBrandJson(org.data.brandConfig ? JSON.stringify(org.data.brandConfig, null, 2) : "{}");
    setNameInitialized(true);
  }

  const updateOrg = api.settings.updateOrgDetails.useMutation({
    onSuccess: () => utils.settings.getOrgDetails.invalidate(),
  });

  const updateBrand = api.settings.updateBrandConfig.useMutation({
    onSuccess: () => utils.settings.getOrgDetails.invalidate(),
  });

  function handleSaveOrg() {
    updateOrg.mutate({ name, slug });
  }

  function handleSaveBrand() {
    try {
      const parsed = JSON.parse(brandJson);
      updateBrand.mutate({ brandConfig: parsed });
    } catch {
      alert("Invalid JSON");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-8 text-2xl font-bold text-gray-900">Settings</h1>

        {/* Org Details */}
        <section className="mb-8 rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Organization</h2>
          {org.isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : org.data ? (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Slug</label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>
              <div className="flex items-center gap-4 text-sm text-gray-500">
                <span>Tier: {org.data.pricingTier}</span>
                <span>Budget: ${(org.data.dailyLlmBudgetCents / 100).toFixed(2)}/day</span>
                <span>Max Accounts: {org.data.maxAccounts}</span>
              </div>
              <button
                onClick={handleSaveOrg}
                disabled={updateOrg.isPending}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-50"
              >
                {updateOrg.isPending ? "Saving..." : "Save"}
              </button>
              {updateOrg.error && (
                <p className="text-sm text-red-600">{updateOrg.error.message}</p>
              )}
            </div>
          ) : null}
        </section>

        {/* Platform Connections */}
        <section className="mb-8 rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Platform Connections</h2>
          {tokens.isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : !tokens.data?.length ? (
            <p className="text-gray-500">No accounts connected</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {tokens.data.map((token) => (
                <div key={token.id} className="flex items-center justify-between py-3">
                  <div>
                    <span className="text-sm font-medium text-gray-900">
                      {token.platform} — {token.accountLabel}
                    </span>
                    <span className="ml-2 text-xs text-gray-400">{token.accountType}</span>
                    {token.warmupStatus !== "READY" && (
                      <span className="ml-2 text-xs text-yellow-600">{token.warmupStatus}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <div className="h-2 w-16 overflow-hidden rounded-full bg-gray-200">
                        <div
                          className="h-full rounded-full bg-green-500"
                          style={{ width: `${token.healthScore * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500">
                        {(token.healthScore * 100).toFixed(0)}%
                      </span>
                    </div>
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        CIRCUIT_COLORS[token.circuitState] ?? "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {token.circuitState}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Brand Config */}
        <section className="rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Brand Configuration</h2>
          <textarea
            value={brandJson}
            onChange={(e) => setBrandJson(e.target.value)}
            rows={10}
            className="w-full rounded-md border px-3 py-2 font-mono text-sm"
            placeholder='{"voice": "professional", "tone": "friendly"}'
          />
          <button
            onClick={handleSaveBrand}
            disabled={updateBrand.isPending}
            className="mt-3 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-50"
          >
            {updateBrand.isPending ? "Saving..." : "Save Brand Config"}
          </button>
          {updateBrand.error && (
            <p className="mt-2 text-sm text-red-600">{updateBrand.error.message}</p>
          )}
        </section>
      </div>
    </div>
  );
}
