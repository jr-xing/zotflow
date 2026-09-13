/**
 * The reader already bundles its own MathJax 3 renderer. Its old bootstrap also
 * imports Obsidian's MathJax 3 script, which Obsidian 1.14.1 replaced with MathJax
 * 4. That leaves a partial global MathJax object and makes the bundled renderer
 * throw before the reader can connect. Remove only this obsolete host setup.
 * Keep this compatibility patch here so the upstream reader stays unmodified.
 */
export function patchReaderHTML(html: string): string {
    return html
        .replace(
            /\/\/ Set up MathJax\s+window\.MathJax = \{\s+chtml: \{[\s\S]*?\n\s*\};/,
            "// Math rendering uses the reader's bundled MathJax.",
        )
        .replace(
            /<script\s+src=["']\/lib\/mathjax\/tex-chtml-full\.js["']\s*><\/script>/,
            "",
        );
}

// Prepended when creating the Document Worker Blob, before upstream code runs.
// Older iPad WebViews lack these APIs. The Reader iframe's polyfills cannot reach
// this separate worker global, including SDT modules loaded into it later.
export const DOCUMENT_WORKER_PREAMBLE = `
if (typeof Promise.withResolvers !== "function") {
    Object.defineProperty(Promise, "withResolvers", {
        configurable: true,
        writable: true,
        value: function withResolvers() {
            var resolve, reject;
            var promise = new this(function (res, rej) {
                resolve = res;
                reject = rej;
            });
            return { promise: promise, resolve: resolve, reject: reject };
        }
    });
}

// The pinned Document Worker uses values().flatMap(), values().some() and
// keys().find(). Built-in iterators share this prototype even on WebViews
// without a global Iterator constructor. Keep flatMap lazy and let for...of
// close iterators when a predicate returns early or a callback throws.
(() => {
    const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    const methods = {
        flatMap: function* flatMap(mapper) {
            let index = 0;
            for (const value of this) {
                yield* mapper(value, index++);
            }
        },
        some: function some(predicate) {
            let index = 0;
            for (const value of this) {
                if (predicate(value, index++)) return true;
            }
            return false;
        },
        find: function find(predicate) {
            let index = 0;
            for (const value of this) {
                if (predicate(value, index++)) return value;
            }
            return undefined;
        }
    };
    for (const [name, method] of Object.entries(methods)) {
        if (typeof prototype[name] !== "function") {
            Object.defineProperty(prototype, name, {
                configurable: true,
                writable: true,
                value: method
            });
        }
    }
})();
`;

/**
 * Upstream silently replaces failed PDF layout inference with plain text. That
 * loses image/equation blocks and can change reading order, so Read Mode must
 * reject it instead of caching it as a successful result.
 *
 * Both upstream fallback recorders append to layoutFallbacks. Throw there,
 * while the page and original error are still available: the final SDT pack
 * only retains extractionDegraded. The existing worker error response then
 * reaches ReaderSDT's log/notice and lets the user retry after fixing the Pack.
 * Match property names rather than the upstream minifier's local names.
 */
export function patchDocumentWorkerScript(data: Uint8Array): string {
    // ONNX requests 16 MiB initially but reserves a shared-memory maximum of
    // 4 GiB. iOS 16 WebKit can reject that reservation before loading a model
    // (https://bugs.webkit.org/show_bug.cgi?id=255103). Retry this allocation
    // once with a 1 GiB ceiling; keep the normal path and all other WASM memories
    // intact. WASM pages are 64 KiB, and shared:true is required by this binary
    // even though ONNX is configured to run with one thread.
    const source = new TextDecoder().decode(data).replace(
        "new WebAssembly.Memory({initial:256,maximum:65536,shared:!0})",
        `(() => {
            try {
                return new WebAssembly.Memory({initial:256,maximum:65536,shared:true});
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                try {
                    return new WebAssembly.Memory({initial:256,maximum:16384,shared:true});
                } catch (retryError) {
                    throw new Error("ONNX WASM memory allocation failed (16 MiB initial, 1 GiB maximum): "
                        + retryError);
                }
            }
        })()`,
    );
    const patched = source.replace(
        /([\w$]+\.layoutFallbacks\.push)\(([\w$]+)\)/g,
        (_match: string, push: string, record: string) => `${push}((() => {
            const fallback = ${record};
            if (fallback.reason === "inference_error" || fallback.reason === "too_many_lines") {
                const detail = fallback.errorMessage
                    ? (fallback.errorName || "Error") + ": " + fallback.errorMessage
                    : "line count " + fallback.lineCount + " exceeds " + fallback.limit;
                throw new Error("SDT layout extraction failed on page " + fallback.pageNumber
                    + " (" + fallback.reason + "): " + detail);
            }
            return fallback;
        })())`,
    );
    return DOCUMENT_WORKER_PREAMBLE + patched;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    const len = bytes.byteLength;
    const CHUNK_SIZE = 32768;
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, len));
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

/** -----------------------------------------------------------
 * This function is used to patch the viewer.css file, since css cannot use blob URLs directly.
 * It will replace the original URLs with data URLs instead.
 * ------------------------------------------------------------
 */

function getPatchedViewerCSS(
    BLOB_BINARY_MAP: Record<string, { type: string; data: Uint8Array }>,
): string {
    const originalCSS = BLOB_BINARY_MAP["pdf/web/viewer.css"];
    if (!originalCSS) return "";

    const text = new TextDecoder("utf-8").decode(originalCSS.data);

    // Match url(...)
    const relativeUrlPattern =
        /url\(\s*(['"]?)(?![a-z][\w+.-]*:|\/\/)([^'")]+)\1\s*\)/g;

    // `String.replace` types every capture after the match as `any`; both of
    // these are groups in `relativeUrlPattern`, so they are always strings.
    return text.replace(
        relativeUrlPattern,
        (match: string, _quote: string, url: string) => {
            // Extract pure filename (remove path and query parameters)
            const basename = url.match(/([^/?#]+)(?:\?.*)?$/)?.[1];

            if (!basename) return match;

            // Find matching resource
            const hitKey = Object.keys(BLOB_BINARY_MAP).find((k) =>
                k.endsWith(basename),
            );

            if (hitKey) {
                const resource = BLOB_BINARY_MAP[hitKey]!;
                const base64 = uint8ArrayToBase64(resource.data);
                const mimeType = resource.type || "application/octet-stream";

                return `url("data:${mimeType};base64,${base64}")`;
            } else {
                console.warn(`[Zotero Reader] CSS Resource not found: ${url}`);
                return match;
            }
        },
    );
}

/** -----------------------------------------------------------
 * This function is used to patch the PDF viewer HTML file to use the blob URLs
 * for inline resources instead of the original URLs.
 * The following will be replaced in the viewer.html:
 * - fetch
 * - XMLHttpRequest
 * ------------------------------------------------------------
 */
export function patchPDFJSViewerHTML(
    BLOB_BINARY_MAP: Record<string, { type: string; data: Uint8Array }>,
    BLOB_URL_MAP: Record<string, string>,
) {
    // Get original HTML bytes
    let originalHTML = BLOB_BINARY_MAP["pdf/web/viewer.html"];
    if (!originalHTML) return "";
    let originalHTMLText = originalHTML.data;
    const BOM = [0xef, 0xbb, 0xbf];
    if (
        originalHTMLText[0] === BOM[0] &&
        originalHTMLText[1] === BOM[1] &&
        originalHTMLText[2] === BOM[2]
    ) {
        originalHTMLText = originalHTMLText.slice(3);
    }
    const text = new TextDecoder("utf-8").decode(originalHTMLText);

    // Parse into a DOM
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/html");

    const cssLinks = doc.querySelectorAll(
        'link[rel="stylesheet"][href="viewer.css"]',
    );
    cssLinks.forEach((linkEl) => {
        const styleEl = doc.createElement("style");
        styleEl.textContent = getPatchedViewerCSS(BLOB_BINARY_MAP);
        linkEl.replaceWith(styleEl);
    });

    // Rewrite <script type="module" src="...">
    const moduleScripts = doc.querySelectorAll('script[type="module"][src]');
    moduleScripts.forEach((scriptEl) => {
        const src = scriptEl.getAttribute("src") || "";
        // Find a key whose basename matches (similar to your RegExp logic)
        const basenameMatch = src.match(/([^/?#]+)(?:\?.*)?$/);
        const basename = basenameMatch?.[1];
        if (basename) {
            const hit = Object.keys(BLOB_URL_MAP).find((k) =>
                k.includes(basename),
            );
            if (hit) {
                scriptEl.setAttribute("src", BLOB_URL_MAP[hit]!);
            } else {
                console.warn(`No blob URL found for ${src}`);
            }
        }
    });

    // Build the patch scripts as raw HTML strings (injected before </head> below
    // during serialization).
    const blobMapScriptHTML =
        '<script type="module">' +
        `window.BLOB_URL_MAP = ${JSON.stringify(BLOB_URL_MAP)};` +
        "</script>";

    const patchScriptBody = `
        function getBlobUrlForRequest(requestedUrl) {
            if (!requestedUrl) return null;
            const isRelative = !/^[a-zA-Z][a-zA-Z\\d+\\-.]*:/.test(requestedUrl) && !requestedUrl.startsWith("//");
            
            if (isRelative) {
                const match = requestedUrl.match(/([^\\/?#]+)(?:\\?.*)?$/);
                const basename = match ? match[1] : requestedUrl;
                
                const key = Object.keys(window.BLOB_URL_MAP).find(k => k.endsWith(basename));
                return key ? window.BLOB_URL_MAP[key] : null;
            }
            return null;
        }

        // Patch Fetch
        const realFetch = window.fetch;
        window.fetch = async function(input, init) {
            const url = typeof input === "string" ? input : (input.url || "");
            const blobUrl = getBlobUrlForRequest(url);
            if (blobUrl) {
                // console.debug("Patched Fetch:", url);
                return realFetch(blobUrl, init);
            }
            return realFetch(input, init);
        };

        // Patch XHR
        const OriginalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open;
            xhr.open = function(method, url, ...args) {
                const blobUrl = getBlobUrlForRequest(url);
                if (blobUrl) {
                    // console.debug("Patched XHR:", url);
                    return originalOpen.call(this, method, blobUrl, ...args);
                }
                return originalOpen.call(this, method, url, ...args);
            };
            return xhr;
        };
        Object.assign(window.XMLHttpRequest, OriginalXHR);

		
    // Test patched fetch
    // fetch('standard_fonts/FoxitFixedBoldItalic.pfb')
    //   .then(r => r.ok ? r.arrayBuffer() : null)
    //   .then(buf => {
    //     if (buf) console.debug('Font data (fetch):', buf.byteLength, 'bytes');
    //   });

    // Test patched XHR
    // const xhr = new XMLHttpRequest();
    // xhr.open('GET', 'standard_fonts/FoxitFixedBoldItalic.pfb', true);
    // xhr.responseType = 'arraybuffer';
    // xhr.onload = function () {
    //   if (this.response) {
    //     console.debug('Font data (XHR):', this.response.byteLength, 'bytes');
    //   }
    // };
    // xhr.send();
    `.trim();

    const patchScriptHTML =
        '<script type="module">' + patchScriptBody + "</script>";

    // Serialize DOM back to HTML, then string-inject the two patch scripts at
    // the very top of <head>. String injection (rather than DOM insertion) is
    // intentional — see the comment above where blobMapScriptHTML is built.
    const doctype = Array.from(doc.childNodes).find(
        (n) => n.nodeType === Node.DOCUMENT_TYPE_NODE,
    ) as DocumentType | undefined;

    let serialized =
        (doctype ? `<!DOCTYPE ${doctype.name}>\n` : "<!DOCTYPE html>\n") +
        doc.documentElement.outerHTML;

    // Insert: blob map first, then the monkey patch (both before any existing
    // child of <head>). Falls back to appending right before </head>.
    const injected = blobMapScriptHTML + patchScriptHTML;
    const headOpenMatch = serialized.match(/<head\b[^>]*>/i);
    if (headOpenMatch) {
        const idx = headOpenMatch.index! + headOpenMatch[0].length;
        serialized =
            serialized.slice(0, idx) + injected + serialized.slice(idx);
    } else {
        serialized = serialized.replace(/<\/head>/i, injected + "</head>");
    }

    return serialized;
}
