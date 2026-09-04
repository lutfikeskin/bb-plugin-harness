import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

describe("plugin contract", () => {
  it("imports only public SDK surfaces (plus declared runtime deps)", () => {
    const result = experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^react$/,
        /^react-dom$/,
        /^@\//,
        /^zod$/,
        /^clsx$/,
        /^tailwind-merge$/,
        /^class-variance-authority$/,
        /^@radix-ui\//,
        /^@hugeicons\//,
        /^sonner$/,
        /^vaul$/,
        /^@testing-library\//,
        /^vitest/,
      ],
    });
    expect(result.privateDependencies).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("stamps matching package identity in bundle metadata", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    for (const file of ["dist/server.meta.json", "dist/app.meta.json"]) {
      if (!existsSync(path.join(process.cwd(), file))) continue;
      const meta = JSON.parse(readFileSync(path.join(process.cwd(), file), "utf8")) as Record<string, unknown>;
      // dist metadata stamps the plugin id (harness) and exact SDK/build versions.
      expect(JSON.stringify(meta)).toContain("harness");
      if (typeof meta.pluginVersion === "string") expect(meta.pluginVersion).toBe(pkg.version);
      if (typeof meta.pluginSdkVersion === "string") expect(meta.pluginSdkVersion).toMatch(/^\d+\.\d+/);
    }
  });
});
