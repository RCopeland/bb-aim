// Integration tests for `server.ts`, driven through the official
// `@get-bb/plugin-sdk/testing` fake host: a real plugin load, real RPC
// dispatch (with the contract's zod validation), a real SQLite database, and
// a real Hono context for the HTTP route.
//
// The wallpaper upload path is the security-relevant surface here: it is the
// code that decides whether caller-supplied bytes become a served response.
// The claim under test is that the *bytes* decide the MIME type, never the
// caller's claimed `mimeType`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

/** A 1x1 PNG — the smallest thing that carries a real PNG signature. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** Real magic-byte prefixes for each supported format, padded to be valid-ish. */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32, 0x11),
]);
const GIF_BYTES = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  Buffer.alloc(32, 0x22),
]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.alloc(32, 0x33),
]);

function base64(bytes: Buffer): string {
  return bytes.toString("base64");
}

/** A buffer that no format detector should accept (plain ASCII text). */
const NOT_AN_IMAGE = Buffer.from("this is definitely not an image", "utf8");

describe("wallpaper RPC", () => {
  let host: FakePluginHost;

  beforeEach(async () => {
    host = createFakePluginHost({ pluginId: "aim" });
    await plugin(host.bb);
  });

  afterEach(async () => {
    await host.harness.lifecycle.dispose();
  });

  describe("wallpaper_get", () => {
    it("reports nothing set on a fresh install", async () => {
      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toEqual({ set: false, mime: null, url: null });
    });

    it("returns the stored mime and a served url after a set", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/png",
      });

      const state = await host.harness.behavior.callRpc("wallpaper_get", null);
      expect(state).toMatchObject({ set: true, mime: "image/png" });
      expect((state as { url: string }).url).toContain("/http/wallpaper");
    });
  });

  describe("wallpaper_set", () => {
    it.each([
      ["png", PNG_BASE64, "image/png"],
      ["jpeg", base64(JPEG_BYTES), "image/jpeg"],
      ["gif", base64(GIF_BYTES), "image/gif"],
      ["webp", base64(WEBP_BYTES), "image/webp"],
    ])("accepts a real %s by its magic bytes", async (_label, data, mime) => {
      const result = await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: data,
        mimeType: mime,
      });
      expect(result).toMatchObject({ set: true });

      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toMatchObject({ set: true, mime });
    });

    // The core security claim: a spoofed mimeType must not influence the
    // stored type — the bytes win. A PNG announced as a JPEG is stored as PNG.
    it("ignores a spoofed mimeType and trusts the bytes", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/jpeg",
      });

      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toMatchObject({ mime: "image/png" });
    });

    // Conversely, an image format announced via a content-type the plugin
    // does not support is still accepted on its bytes.
    it("accepts a supported image whose claimed mimeType is not in the allowlist", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: base64(GIF_BYTES),
        mimeType: "application/octet-stream",
      });

      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toMatchObject({ mime: "image/gif" });
    });

    it("rejects bytes that are not a supported image", async () => {
      await expect(
        host.harness.behavior.callRpc("wallpaper_set", {
          dataBase64: base64(NOT_AN_IMAGE),
          mimeType: "image/png",
        }),
      ).rejects.toThrow(/Unsupported file/i);
    });

    // An empty upload is a distinct, friendlier error than "unsupported",
    // so the user learns the file was blank rather than mis-typed.
    it("rejects an empty upload", async () => {
      await expect(
        host.harness.behavior.callRpc("wallpaper_set", {
          dataBase64: "",
          mimeType: "image/png",
        }),
      ).rejects.toThrow(/empty/i);
    });

    // The 10 MB cap is enforced before any write, so an oversized upload
    // cannot bloat the plugin database.
    it("rejects an upload over the size cap", async () => {
      const oversized = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // valid JPEG signature
        Buffer.alloc(10 * 1024 * 1024 + 1, 0x11),
      ]);

      await expect(
        host.harness.behavior.callRpc("wallpaper_set", {
          dataBase64: oversized.toString("base64"),
          mimeType: "image/jpeg",
        }),
      ).rejects.toThrow(/too large/i);

      // The failed upload must not have stored anything.
      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toEqual({ set: false, mime: null, url: null });
    });

    it("rejects input that violates the contract schema", async () => {
      await expect(
        host.harness.behavior.callRpc("wallpaper_set", { dataBase64: PNG_BASE64 }),
      ).rejects.toThrow();

      await expect(
        host.harness.behavior.callRpc("wallpaper_set", {
          dataBase64: PNG_BASE64,
          mimeType: "image/png",
          surprise: true,
        }),
      ).rejects.toThrow();
    });

    // A second upload replaces the first rather than accumulating rows; the
    // table is a single-row slot (id = 1).
    it("replaces a previously stored wallpaper", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/png",
      });
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: base64(GIF_BYTES),
        mimeType: "image/gif",
      });

      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toMatchObject({ set: true, mime: "image/gif" });
    });

    it("publishes the change signal so open desktops can react", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/png",
      });

      expect(
        host.harness.inspection.realtimeSignals.some((signal) =>
          signal.channel.includes("wallpaper"),
        ),
      ).toBe(true);
    });
  });

  describe("wallpaper_clear", () => {
    it("clears a stored wallpaper and reports the cleared state", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/png",
      });

      await expect(
        host.harness.behavior.callRpc("wallpaper_clear", null),
      ).resolves.toEqual({ set: false, url: null });

      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toEqual({ set: false, mime: null, url: null });
    });

    it("is safe to call when nothing is set", async () => {
      await expect(
        host.harness.behavior.callRpc("wallpaper_clear", null),
      ).resolves.toEqual({ set: false, url: null });
    });
  });

  describe("GET /wallpaper", () => {
    it("404s before anything is uploaded", async () => {
      const response = await host.harness.behavior.fetchHttp(
        "GET",
        "/wallpaper",
      );
      expect(response.status).toBe(404);
    });

    it("serves the stored bytes with the detected content-type", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/png",
      });

      const response = await host.harness.behavior.fetchHttp(
        "GET",
        "/wallpaper",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      // The served bytes must round-trip exactly.
      const served = Buffer.from(await response.arrayBuffer());
      expect(served.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
    });

    // Serve-by-detected-type, not by claimed type: this is the same trust
    // boundary as the set path, observed from the response side.
    it("serves the detected type even when the upload claimed another", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: base64(WEBP_BYTES),
        mimeType: "text/html",
      });

      const response = await host.harness.behavior.fetchHttp(
        "GET",
        "/wallpaper",
      );
      expect(response.headers.get("content-type")).toBe("image/webp");
    });

    it("404s again after the wallpaper is cleared", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/png",
      });
      await host.harness.behavior.callRpc("wallpaper_clear", null);

      const response = await host.harness.behavior.fetchHttp(
        "GET",
        "/wallpaper",
      );
      expect(response.status).toBe(404);
    });
  });

  // Persistence is the reason this lives server-side at all: the wallpaper
  // must survive a plugin reload, not just a browser refresh.
  describe("persistence across a reload", () => {
    it("keeps the wallpaper when the plugin reloads", async () => {
      await host.harness.behavior.callRpc("wallpaper_set", {
        dataBase64: PNG_BASE64,
        mimeType: "image/png",
      });

      // reload() closes the old database handle and poisons the previous
      // `bb`, so the *returned* host is the only valid handle afterwards.
      host = await host.harness.lifecycle.reload(plugin);

      await expect(
        host.harness.behavior.callRpc("wallpaper_get", null),
      ).resolves.toMatchObject({ set: true, mime: "image/png" });

      const response = await host.harness.behavior.fetchHttp("GET", "/wallpaper");
      expect(response.status).toBe(200);
    });
  });

  it("exposes exactly the wallpaper RPC methods", async () => {
    // Guards the deliberate removal of thread_history / thread_send: the IM
    // window renders the host's own ThreadChat, so the plugin must not grow
    // thread read/write RPCs again.
    const methods = host.harness.inspection.registrations.rpcMethods ?? [];
    expect([...methods].sort()).toEqual([
      "wallpaper_clear",
      "wallpaper_get",
      "wallpaper_set",
    ]);
  });
});
