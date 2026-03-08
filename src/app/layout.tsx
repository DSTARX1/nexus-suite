import type { Metadata } from "next";
import { Providers } from "./providers";
import { Sidebar } from "./sidebar";

export const metadata: Metadata = {
  title: "Nexus Suite",
  description: "AI-powered social media management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
