// bb-plugin-aim — BB plugin backend entry.
//
// The AIM desktop is a frontend feature (reads sidebar thread hooks and
// renders in-app floating windows), but it has one server-side piece: the
// user-chosen wallpaper must persist across reloads/app restarts. We store
// the uploaded image bytes as a BLOB in the plugin's SQLite database
// (<dataDir>/plugins/aim/data.db, plugin-owned via bb.storage.database) and
// serve it back through a plugin HTTP route. Base64-in-settings is rejected
// here because wallpapers routinely exceed bb.storage.kv's 256KB cap; the
// DB blob + route is the reliable, size-unbounded path.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { z } from "zod";

const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024; // 10 MB

/** One row per plugin; id=1 is the single wallpaper slot. */
const WALLPAPER_TABLE = `
CREATE TABLE IF NOT EXISTS aim_wallpaper (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data BLOB NOT NULL,
  mime TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const rpcContract = defineRpcContract({
  wallpaper_get: {
    input: z.null(),
    output: z.object({
      set: z.boolean(),
      mime: z.string().nullable(),
      /** Relative URL to serve the image, or null when unset. */
      url: z.string().nullable(),
    }),
  },
  wallpaper_set: {
    input: z
      .object({ dataBase64: z.string(), mimeType: z.string() })
      .strict(),
    output: z.object({ set: z.boolean(), url: z.string() }),
  },
  wallpaper_clear: {
    input: z.null(),
    output: z.object({ set: z.boolean(), url: z.null() }),
    // url: null only — zod output can be { set: boolean } too; keep simple below
  },
});
// NOTE: the transcript/send RPCs (`thread_history`, `thread_send`) and the
// timeline-flattening helpers behind them were removed. The IM window now
// renders the host's own `ThreadChat`, so the plugin no longer reimplements
// thread reads or sends — that hand-rolled path dropped tool/diff/file/queue
// rows and bypassed the host submit pipeline.
// Make the clear output a plain object to keep the null-only url.
type WallpaperClearOutput = { set: boolean; url: null };

const WALLPAPER_CHANGED = "aim-wallpaper-changed";

/**
 * Detect the real image format from magic bytes. The client also sends a
 * claimed MIME type, but we trust the bytes (ignore a spoofed header).
 */
function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (bytes.length >= 12) {
    // WebP: "RIFF"...."WEBP"
    const riff =
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const webp =
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (riff && webp) return "image/webp";
  }
  return null;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const db = bb.storage.database();
  bb.storage.migrate(db, [WALLPAPER_TABLE]);

  const wallpaperUrl = `/api/v1/plugins/${bb.pluginId}/http/wallpaper`;

  // --- Persistence helpers (single-row upsert keyed id=1). ---
  function readWallpaper(): { data: Buffer; mime: string } | null {
    const row = db
      .prepare("SELECT data, mime FROM aim_wallpaper WHERE id = 1")
      .get() as { data: Buffer; mime: string } | undefined;
    return row ? { data: row.data, mime: row.mime } : null;
  }
  function writeWallpaper(data: Buffer, mime: string): void {
    db.prepare(
      `INSERT INTO aim_wallpaper (id, data, mime, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, mime = excluded.mime, updated_at = excluded.updated_at`,
    ).run(data, mime, Date.now());
  }
  function clearWallpaper(): void {
    db.prepare("DELETE FROM aim_wallpaper WHERE id = 1").run();
  }

  // --- Serve the stored image over a plugin HTTP route. ---
  bb.http.route(
    "GET",
    "/wallpaper",
    (context: Context) => {
      const stored = readWallpaper();
      if (!stored) {
        return new Response("no wallpaper set", { status: 404 });
      }
      return new Response(Uint8Array.from(stored.data), {
        status: 200,
        headers: {
          "content-type": stored.mime,
          "cache-control": "no-store",
        },
      });
    },
    { auth: "local" },
  );

  // --- RPC: state query, upload (base64), clear. ---
  bb.rpc.register(rpcContract, {
    wallpaper_get: () => {
      const stored = readWallpaper();
      return {
        set: stored !== null,
        mime: stored?.mime ?? null,
        url: stored ? wallpaperUrl : null,
      };
    },
    wallpaper_set: async ({ dataBase64 }) => {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(dataBase64, "base64");
      } catch {
        throw new Error("Could not decode the uploaded image data.");
      }
      if (bytes.length === 0) {
        throw new Error("The uploaded file is empty.");
      }
      if (bytes.length > MAX_WALLPAPER_BYTES) {
        throw new Error("Image is too large (max 10 MB).");
      }
      const mime = detectImageMime(bytes);
      if (mime === null) {
        throw new Error(
          "Unsupported file. Upload a raster image (PNG, JPEG, GIF, or WebP).",
        );
      }
      writeWallpaper(bytes, mime);
      bb.realtime.publish(WALLPAPER_CHANGED, { set: true, mime });
      return { set: true, url: wallpaperUrl };
    },
    wallpaper_clear: (): WallpaperClearOutput => {
      clearWallpaper();
      bb.realtime.publish(WALLPAPER_CHANGED, { set: false });
      return { set: false, url: null };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}