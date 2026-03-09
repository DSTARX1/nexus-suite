import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

// Edge-safe auth config — no DB adapter, no Node.js-only imports.
// Used by middleware. Full config with adapter lives in config.ts.
export const authConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      return true; // Let middleware.ts handle route logic
    },
  },
} satisfies NextAuthConfig;
