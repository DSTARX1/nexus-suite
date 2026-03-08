import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.join(__dirname, "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL ?? "postgres://imorgado@localhost:5432/nexus_feature7",
  },
});
