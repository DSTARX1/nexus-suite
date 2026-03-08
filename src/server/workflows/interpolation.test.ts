import { describe, it, expect } from "vitest";
import { interpolate, interpolateParams } from "./interpolation";

describe("interpolate", () => {
  it("resolves simple {{var}}", () => {
    expect(interpolate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("resolves dot-path {{config.threshold}}", () => {
    expect(
      interpolate("Threshold: {{config.threshold}}", {
        config: { threshold: 7 },
      }),
    ).toBe("Threshold: 7");
  });

  it("resolves array index {{items[0].name}}", () => {
    const vars = { items: [{ name: "first" }, { name: "second" }] };
    expect(interpolate("Item: {{items[0].name}}", vars)).toBe("Item: first");
    expect(interpolate("Item: {{items[1].name}}", vars)).toBe("Item: second");
  });

  it("serializes nested objects to JSON", () => {
    const vars = { data: { a: 1, b: "two" } };
    const result = interpolate("Result: {{data}}", vars);
    expect(result).toBe('Result: {"a":1,"b":"two"}');
  });

  it("unresolved vars stay as {{placeholder}}", () => {
    expect(interpolate("{{missing}}", {})).toBe("{{missing}}");
  });

  it("handles multiple vars in one template", () => {
    expect(
      interpolate("{{a}} and {{b}}", { a: "X", b: "Y" }),
    ).toBe("X and Y");
  });

  it("handles null/undefined values as placeholder", () => {
    expect(interpolate("{{val}}", { val: null })).toBe("{{val}}");
    expect(interpolate("{{val}}", { val: undefined })).toBe("{{val}}");
  });
});

describe("interpolateParams", () => {
  it("recurses objects", () => {
    const result = interpolateParams(
      {
        url: "https://api.example.com/{{endpoint}}",
        headers: {
          auth: "Bearer {{token}}",
        },
      },
      { endpoint: "users", token: "abc123" },
    );
    expect(result).toEqual({
      url: "https://api.example.com/users",
      headers: {
        auth: "Bearer abc123",
      },
    });
  });

  it("passes through non-string values", () => {
    const result = interpolateParams(
      { count: 42, flag: true, name: "{{x}}" },
      { x: "val" },
    );
    expect(result).toEqual({ count: 42, flag: true, name: "val" });
  });

  it("passes through arrays as-is", () => {
    const result = interpolateParams(
      { tags: ["a", "b"] as any },
      {},
    );
    expect(result.tags).toEqual(["a", "b"]);
  });
});
