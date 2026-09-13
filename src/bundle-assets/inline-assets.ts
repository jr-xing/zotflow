import { gunzipSync } from "fflate";
import {
    patchDocumentWorkerScript,
    patchPDFJSViewerHTML,
    patchReaderHTML,
} from "./patch-inlined-assets";
import resourceContext, { resourceKeys } from "virtual:reader-resources";

const mimeTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".wasm": "application/wasm",
    ".mjs": "application/javascript",
    ".js": "application/javascript",
    ".json": "application/json",
    ".txt": "text/plain",
    ".css": "text/css",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".pfb": "application/x-font-type1",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json",
    ".bcmap": "application/octet-stream",
    ".icc": "application/vnd.iccprofile",
};

/**
 * Ungzip Base64
 */
const ungzipDataSync = (
    base64: string,
    timing: { base64Ms: number; gzipMs: number },
): Uint8Array => {
    const started = performance.now();
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const decoded = performance.now();
    timing.base64Ms += decoded - started;
    const data = gunzipSync(bytes);
    timing.gzipMs += performance.now() - decoded;
    return data;
};

/**
 * Initialize Blob URLs
 */
function initializeBlobUrls(
    reportTiming?: (details: Record<string, unknown>) => void,
): Record<string, string> {
    const started = performance.now();
    const timing = { base64Ms: 0, gzipMs: 0, blobMs: 0 };
    const resourceTimings: {
        file: string;
        durationMs: number;
        bytes: number;
    }[] = [];
    const BLOB_URL_MAP: Record<string, string> = {};
    const BLOB_BINARY_MAP: Record<string, { type: string; data: Uint8Array }> =
        {};

    const keys = resourceKeys();

    keys.forEach((key) => {
        // Get Gzip Base64
        const gzippedBase64 = resourceContext(key);

        const fileName = key.replace("./", "");
        // Calculate MIME
        const ext = fileName.slice(fileName.lastIndexOf("."));
        const type = mimeTypes[ext] || "application/octet-stream";

        // Both sides come from the same build step, so a key with no contents
        // means the two fell out of step rather than a missing file.
        if (gzippedBase64 === undefined) {
            console.error(`No bundled contents for ${fileName}`);
            return;
        }

        try {
            const resourceStarted = performance.now();
            // Wait for unzipping
            const rawData = ungzipDataSync(gzippedBase64, timing);
            const decompressedData =
                fileName === "reader.html"
                    ? new TextEncoder().encode(
                          patchReaderHTML(new TextDecoder().decode(rawData)),
                      )
                    : rawData;

            // Store in Binary Map (for patcher)
            BLOB_BINARY_MAP[fileName] = { type, data: decompressedData };

            // Create Blob URL
            const blobStarted = performance.now();
            const blob = new Blob([decompressedData as BlobPart], { type });
            const url = URL.createObjectURL(blob);
            BLOB_URL_MAP[fileName] = url;
            const finished = performance.now();
            timing.blobMs += finished - blobStarted;
            resourceTimings.push({
                file: fileName,
                durationMs: Number((finished - resourceStarted).toFixed(2)),
                bytes: decompressedData.byteLength,
            });
        } catch (e) {
            console.error(`Failed to bundle ${fileName}`, e);
        }
    });

    // Apply resource patches after all original bytes and URLs are available.
    // Patch the worker first so viewer.html receives the final worker URL.
    const workerPatchStarted = performance.now();
    const workerScript = BLOB_BINARY_MAP["document-worker/worker.js"];
    if (workerScript) {
        const workerBlob = new Blob(
            [patchDocumentWorkerScript(workerScript.data)],
            { type: workerScript.type },
        );
        const workerUrl = URL.createObjectURL(workerBlob);
        const originalUrl = BLOB_URL_MAP["document-worker/worker.js"];
        if (originalUrl) URL.revokeObjectURL(originalUrl);
        BLOB_URL_MAP["document-worker/worker.js"] = workerUrl;
    }
    const patchWorkerMs = performance.now() - workerPatchStarted;

    // Patch viewer.html
    const patchStarted = performance.now();
    const patchedViewerHTML = patchPDFJSViewerHTML(
        BLOB_BINARY_MAP,
        BLOB_URL_MAP,
    );

    const htmlBlob = new Blob([patchedViewerHTML], { type: "text/html" });
    const htmlUrl = URL.createObjectURL(htmlBlob);

    BLOB_URL_MAP["pdf/web/viewer.html"] = htmlUrl;
    BLOB_URL_MAP["pdf/web/viewer.html.srcdoc"] = patchedViewerHTML;

    const finished = performance.now();
    // Aggregate timings once, rather than logging hundreds of resources inside
    // the measured loop. The slowest files overlap the phase totals below.
    reportTiming?.({
        cached: false,
        resourceCount: keys.length,
        durationMs: Number((finished - started).toFixed(2)),
        base64Ms: Number(timing.base64Ms.toFixed(2)),
        gzipMs: Number(timing.gzipMs.toFixed(2)),
        blobMs: Number(timing.blobMs.toFixed(2)),
        patchWorkerMs: Number(patchWorkerMs.toFixed(2)),
        patchViewerMs: Number((finished - patchStarted).toFixed(2)),
        slowestResources: resourceTimings
            .sort((a, b) => b.durationMs - a.durationMs)
            .slice(0, 5),
    });
    return BLOB_URL_MAP;
}

let _cachedBlobMapPromise: Record<string, string> | null = null;

/**
 * Singleton pattern + Promise caching to prevent repeated initialization
 */
export function getBlobUrls(
    reportTiming?: (details: Record<string, unknown>) => void,
): Record<string, string> {
    if (_cachedBlobMapPromise) {
        reportTiming?.({ cached: true });
        return _cachedBlobMapPromise;
    }

    _cachedBlobMapPromise = initializeBlobUrls(reportTiming);

    return _cachedBlobMapPromise;
}

/**
 * Revoke all blob URLs and clear the cache.
 * Call this on plugin unload to prevent memory leaks.
 */
export function revokeBlobUrls(): void {
    if (!_cachedBlobMapPromise) return;
    for (const url of Object.values(_cachedBlobMapPromise)) {
        try {
            URL.revokeObjectURL(url);
        } catch {
            // Ignore revocation errors
        }
    }
    _cachedBlobMapPromise = null;
}
