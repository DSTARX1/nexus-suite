"use client";

import { api } from "@/lib/trpc-client";
import { useRouter } from "next/navigation";

export default function ReactivatePage() {
  const router = useRouter();
  const portalMutation = api.settings.createPortalSession.useMutation({
    onSuccess(data) {
      window.location.href = data.url;
    },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          Subscription Inactive
        </h1>
        <p className="text-gray-600 mb-6">
          Your subscription is no longer active. Reactivate it through the
          billing portal to regain access.
        </p>
        {portalMutation.error && (
          <p className="text-red-600 text-sm mb-4">
            {portalMutation.error.message}
          </p>
        )}
        <button
          onClick={() => portalMutation.mutate()}
          disabled={portalMutation.isPending}
          className="inline-block rounded-lg bg-gray-900 px-6 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {portalMutation.isPending ? "Redirecting..." : "Manage Billing"}
        </button>
      </div>
    </div>
  );
}
