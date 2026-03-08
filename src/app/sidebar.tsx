"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/workflows", label: "Workflows" },
  { href: "/agents", label: "Agents" },
  { href: "/competitors", label: "Competitors" },
  { href: "/settings", label: "Settings" },
];

const PROTECTED_PREFIXES = ["/dashboard", "/competitors", "/workflows", "/agents", "/settings"];

export function Sidebar() {
  const pathname = usePathname();

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isProtected) return null;

  return (
    <aside className="flex w-56 flex-col border-r border-gray-200 bg-white">
      <div className="px-4 py-5">
        <span className="text-lg font-bold text-gray-900">Nexus Suite</span>
      </div>
      <nav className="flex-1 space-y-1 px-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm font-medium transition ${
                active
                  ? "bg-gray-100 text-gray-900"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
