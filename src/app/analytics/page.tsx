"use client";

import { useState } from "react";
import { api } from "@/lib/trpc-client";
import { DataTable, type ColumnDef } from "@/components/ui/data-table";

// ── Period selector ─────────────────────────────────────────────

const PERIODS = ["7d", "30d", "90d"] as const;

function PeriodTabs({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-gray-200 bg-white">
      {PERIODS.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-3 py-1.5 text-sm font-medium transition ${
            value === p
              ? "bg-gray-900 text-white"
              : "text-gray-600 hover:bg-gray-50"
          } ${p === "7d" ? "rounded-l-md" : ""} ${p === "90d" ? "rounded-r-md" : ""}`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// ── Chart (simple bar visualization) ────────────────────────────

function EngagementChart({
  data,
}: {
  data: Array<{ date: string; views: number; likes: number; comments: number }>;
}) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-500">No engagement data for this period</p>;
  }

  const maxViews = Math.max(...data.map((d) => d.views), 1);

  return (
    <div className="flex items-end gap-1" style={{ height: 200 }}>
      {data.map((d) => {
        const height = Math.max((d.views / maxViews) * 100, 2);
        return (
          <div key={d.date} className="group relative flex-1" title={`${d.date}: ${d.views.toLocaleString()} views`}>
            <div
              className="w-full rounded-t bg-blue-500 transition-colors group-hover:bg-blue-600"
              style={{ height: `${height}%` }}
            />
            <div className="pointer-events-none absolute -top-8 left-1/2 hidden -translate-x-1/2 rounded bg-gray-900 px-2 py-1 text-xs text-white group-hover:block">
              {d.views.toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Column defs ─────────────────────────────────────────────────

type TopPost = Record<string, unknown> & {
  id: string;
  title: string;
  platform: string;
  creator: string;
  views: number;
  likes: number;
  comments: number;
  isOutlier: boolean;
};

const topPostColumns: ColumnDef<TopPost>[] = [
  {
    accessorKey: "title",
    header: "Title",
    cell: (row) => (
      <span className="inline-flex items-center gap-1.5">
        {row.isOutlier && (
          <span className="inline-block h-2 w-2 rounded-full bg-orange-500" title="Outlier" />
        )}
        <span className="max-w-[200px] truncate">{row.title}</span>
      </span>
    ),
  },
  { accessorKey: "creator", header: "Creator" },
  { accessorKey: "platform", header: "Platform" },
  { accessorKey: "views", header: "Views", cell: (row) => row.views.toLocaleString() },
  { accessorKey: "likes", header: "Likes", cell: (row) => row.likes.toLocaleString() },
  { accessorKey: "comments", header: "Comments", cell: (row) => row.comments.toLocaleString() },
];

type CompetitorRow = Record<string, unknown> & {
  id: string;
  username: string;
  platform: string;
  followerCount: number;
  postCount: number;
  totalViews: number;
  avgViews: number;
  outliers: number;
};

const competitorColumns: ColumnDef<CompetitorRow>[] = [
  { accessorKey: "username", header: "Creator" },
  { accessorKey: "platform", header: "Platform" },
  { accessorKey: "followerCount", header: "Followers", cell: (row) => row.followerCount.toLocaleString() },
  { accessorKey: "postCount", header: "Posts" },
  { accessorKey: "totalViews", header: "Total Views", cell: (row) => row.totalViews.toLocaleString() },
  { accessorKey: "avgViews", header: "Avg Views", cell: (row) => row.avgViews.toLocaleString() },
  { accessorKey: "outliers", header: "Outliers" },
];

type OwnPost = Record<string, unknown> & {
  id: string;
  platform: string;
  account: string;
  title: string;
  status: string;
  postedAt: Date | null;
};

const ownPostColumns: ColumnDef<OwnPost>[] = [
  { accessorKey: "title", header: "Title", cell: (row) => <span className="max-w-[200px] truncate">{row.title}</span> },
  { accessorKey: "platform", header: "Platform" },
  { accessorKey: "account", header: "Account" },
  {
    accessorKey: "status",
    header: "Status",
    cell: (row) => {
      const colors: Record<string, string> = {
        SUCCESS: "bg-green-100 text-green-800",
        FAILED: "bg-red-100 text-red-800",
        SCHEDULED: "bg-blue-100 text-blue-800",
        POSTING: "bg-yellow-100 text-yellow-800",
      };
      return (
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${colors[row.status] ?? "bg-gray-100 text-gray-800"}`}
        >
          {row.status}
        </span>
      );
    },
  },
];

// ── Platform breakdown bar ──────────────────────────────────────

const PLATFORM_COLORS: Record<string, string> = {
  YOUTUBE: "bg-red-500",
  TIKTOK: "bg-gray-900",
  INSTAGRAM: "bg-pink-500",
  X: "bg-blue-500",
  LINKEDIN: "bg-blue-700",
  FACEBOOK: "bg-indigo-500",
};

function PlatformBreakdown({
  data,
}: {
  data: Array<{ platform: string; total: number; success: number; failed: number; successRate: number }>;
}) {
  if (data.length === 0) {
    return <p className="py-4 text-center text-sm text-gray-500">No platform data yet</p>;
  }

  const maxTotal = Math.max(...data.map((d) => d.total), 1);

  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.platform}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium text-gray-700">{d.platform}</span>
            <span className="text-gray-500">
              {d.total} posts · {d.successRate}% success
            </span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className={`h-full rounded-full transition-all ${PLATFORM_COLORS[d.platform] ?? "bg-gray-500"}`}
              style={{ width: `${(d.total / maxTotal) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [period, setPeriod] = useState("30d");
  const periodInput = { period };

  const summary = api.analytics.getSummary.useQuery(periodInput);
  const engagement = api.analytics.getEngagementOverTime.useQuery(periodInput);
  const topContent = api.analytics.getTopContent.useQuery({ period });
  const competitors = api.analytics.getCompetitorComparison.useQuery(periodInput);
  const platforms = api.analytics.getPlatformBreakdown.useQuery(periodInput);
  const recentPosts = api.analytics.getRecentPosts.useQuery({ limit: 20 });

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <PeriodTabs value={period} onChange={setPeriod} />
        </div>

        {/* Summary Cards */}
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryCard
            label="Total Posts"
            value={summary.data?.totalPosts}
            loading={summary.isLoading}
          />
          <SummaryCard
            label="Success Rate"
            value={summary.data ? `${summary.data.successRate}%` : undefined}
            loading={summary.isLoading}
          />
          <SummaryCard
            label="Total Views"
            value={summary.data?.totalViews.toLocaleString()}
            loading={summary.isLoading}
          />
          <SummaryCard
            label="Avg Views"
            value={summary.data?.avgViews.toLocaleString()}
            loading={summary.isLoading}
          />
          <SummaryCard
            label="Total Likes"
            value={summary.data?.totalLikes.toLocaleString()}
            loading={summary.isLoading}
          />
          <SummaryCard
            label="Outliers Found"
            value={summary.data?.outlierCount}
            loading={summary.isLoading}
          />
        </div>

        {/* Engagement Over Time */}
        <div className="mb-8 rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Engagement Over Time</h2>
          {engagement.isLoading ? (
            <div className="flex h-[200px] items-center justify-center">
              <p className="text-gray-500">Loading...</p>
            </div>
          ) : (
            <EngagementChart data={engagement.data ?? []} />
          )}
          {engagement.data && engagement.data.length > 0 && (
            <div className="mt-2 flex justify-between text-xs text-gray-400">
              <span>{engagement.data[0]?.date}</span>
              <span>{engagement.data[engagement.data.length - 1]?.date}</span>
            </div>
          )}
        </div>

        {/* Two-column: Platform Breakdown + Competitor Comparison */}
        <div className="mb-8 grid gap-8 lg:grid-cols-2">
          {/* Platform Breakdown */}
          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Platform Breakdown</h2>
            {platforms.isLoading ? (
              <p className="text-gray-500">Loading...</p>
            ) : (
              <PlatformBreakdown data={platforms.data ?? []} />
            )}
          </div>

          {/* Competitor Comparison (compact table) */}
          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold text-gray-900">Competitor Comparison</h2>
            <DataTable
              columns={competitorColumns as ColumnDef<Record<string, unknown>>[]}
              data={(competitors.data ?? []) as unknown as Record<string, unknown>[]}
              isLoading={competitors.isLoading}
              emptyMessage="No competitors tracked"
            />
          </div>
        </div>

        {/* Top Content */}
        <div className="mb-8 rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Top Content</h2>
          <DataTable
            columns={topPostColumns as ColumnDef<Record<string, unknown>>[]}
            data={(topContent.data ?? []) as unknown as Record<string, unknown>[]}
            isLoading={topContent.isLoading}
            emptyMessage="No tracked content yet"
          />
        </div>

        {/* Recent Own Posts */}
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Recent Posts</h2>
          <DataTable
            columns={ownPostColumns as ColumnDef<Record<string, unknown>>[]}
            data={(recentPosts.data?.posts ?? []) as unknown as Record<string, unknown>[]}
            isLoading={recentPosts.isLoading}
            emptyMessage="No posts yet"
          />
        </div>
      </div>
    </div>
  );
}

// ── Small components ────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  loading,
}: {
  label: string;
  value?: string | number;
  loading: boolean;
}) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">
        {loading ? "—" : (value ?? 0)}
      </p>
    </div>
  );
}
