import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { patchReaderHTML } from "bundle-assets/patch-inlined-assets";

// Exercise the actual pinned upstream template, so a submodule update also
// checks whether the compatibility patch still covers the reader bootstrap.
const template = readFileSync(
    new URL("../../reader/reader/index.obsidian.reader.html", import.meta.url),
    "utf8",
);

describe("reader MathJax compatibility", () => {
    it.each([
        ["no host MathJax", undefined],
        ["MathJax 4", { version: "4.1.3", loader: { preLoaded() {} } }],
        [
            "MathJax 3",
            {
                version: "3.2.2",
                config: {
                    chtml: { fontURL: "/old-fonts" },
                    loader: { paths: {} },
                },
            },
        ],
    ])("starts without a partial MathJax global with %s", (_name, mathJax) => {
        const html = patchReaderHTML(template);
        const environmentScript = /<script>\s*([\s\S]*?)<\/script>/.exec(html)?.[1];
        expect(environmentScript).toBeDefined();
        let baseURL: string | undefined;
        const parent = {
            MathJax: mathJax,
            location: { origin: "app://obsidian.md" },
        };
        const readerWindow = { parent };
        runInNewContext(environmentScript!, {
            window: readerWindow,
            document: {
                querySelector: () => ({
                    setAttribute: (_name: string, value: string) => {
                        baseURL = value;
                    },
                }),
            },
        });

        expect(baseURL).toBe("app://obsidian.md/");
        expect(readerWindow).not.toHaveProperty("MathJax");
        expect(parent.MathJax).toBe(mathJax);
        expect(html).not.toContain("/lib/mathjax/tex-chtml-full.js");
        expect(html).toContain("/enhance.js");
    });

    it("preserves inline reader code and is safe to apply again", () => {
        const readerModule = '<script type="module">window.readerStarted = true;</script>';
        const html = patchReaderHTML(template + readerModule);
        expect(html.endsWith(readerModule)).toBe(true);
        expect(patchReaderHTML(html)).toBe(html);
    });
});
