import {
    pack,
    rollupFromJsdelivr,
    rollupFromSourcePlugin,
    rollupVirtualPlugin
} from "bring-your-own-storage-utilities/deploy";
import commonjs from "@rollup/plugin-commonjs";
import {fileURLToPath} from "bring-your-own-storage-utilities/find";
import path from "node:path";

import LocalDrive from "localdrive";
import terser from "@rollup/plugin-terser";

const p = fileURLToPath(import.meta.url);
const __dirname = path.dirname(p);

const projectFolder = new LocalDrive(path.resolve(__dirname, "./"));

await pack("ras", "./lib/util/random-access-storage.js", {
    plugins: [
        rollupVirtualPlugin(
            {
                "ras": "export {default as RandomAccessStorage} from 'random-access-storage'"
            }
        ),
        rollupFromJsdelivr(),
        rollupFromSourcePlugin(projectFolder, {asOutput: true})
    ]
});

await pack("./index.js", "./dist/index.min.js", {
    plugins: [
        rollupFromJsdelivr(),
        rollupFromSourcePlugin(projectFolder),
        commonjs(),
        terser()
    ]
});
