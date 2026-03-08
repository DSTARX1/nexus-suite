import { createTRPCRouter } from "./trpc";
import { adminRouter } from "./routers/admin";
import { onboardingRouter } from "./routers/onboarding";
import { dashboardRouter } from "./routers/dashboard";
import { settingsRouter } from "./routers/settings";

export const appRouter = createTRPCRouter({
  admin: adminRouter,
  onboarding: onboardingRouter,
  dashboard: dashboardRouter,
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;
