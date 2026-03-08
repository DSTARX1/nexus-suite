import { createTRPCRouter } from "./trpc";
import { adminRouter } from "./routers/admin";
import { onboardingRouter } from "./routers/onboarding";

export const appRouter = createTRPCRouter({
  admin: adminRouter,
  onboarding: onboardingRouter,
});

export type AppRouter = typeof appRouter;
