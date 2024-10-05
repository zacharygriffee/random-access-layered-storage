import { test } from "brittle";
import b4a from 'b4a'; // Buffer library
import { performance } from 'perf_hooks';
import { promisify } from '../lib/util/promisify.js';
import 'fake-indexeddb/auto';
import { RandomAccessLayeredStorage } from "../index.js";
import RAM from "random-access-memory";

const cleanupArray = [];
const st = RAM.reusable();
function cleanup(store, fn) {
    if (!store && !fn) {
        return Promise.all(cleanupArray.map(({fn, store}) => fn(store)));
    } else if (store) {
        fn ||= async store => {
            await promisify(store, "close");
            await promisify(store, "unlink");
        };
        cleanupArray.push({fn, store});
    }
    return store;
}

function defaultMaker(store, opts) {

    return cleanup(new RandomAccessLayeredStorage(st("big-file"), opts));
}

// Helper function to validate that the data in storage matches the expected data
async function validateLargeDataConsistency(storage, data, t) {
    const length = data.length;
    const actualData = await promisify(storage, 'read', 0, length);

    // Compare every byte of the actual data with the expected data
    t.ok(b4a.equals(actualData, data), 'Data should be consistent for large file');
}

// Stress test for large file sizes and consistency
async function runLargeFileConsistencyTest(storage, label, t) {
    const chunkSize = 1024 * 1024; // 1 MB chunks
    const totalSize = 100 * chunkSize; // 100 MB total file size
    const buffer = b4a.alloc(chunkSize, 'a'); // Fill buffer with 'a' characters
    const expectedData = b4a.alloc(totalSize);

    const startTime = performance.now();

    // Write large data in chunks
    for (let i = 0; i < totalSize; i += chunkSize) {
        await promisify(storage, 'write', i, buffer);
        b4a.copy(buffer, expectedData, i); // Store expected data
    }

    const writeEndTime = performance.now();

    console.log(`${label} - Write time for large file: ${(writeEndTime - startTime).toFixed(2)} ms`);

    // Read back the entire data and validate consistency
    const readStartTime = performance.now();
    await validateLargeDataConsistency(storage, expectedData, t);
    const readEndTime = performance.now();

    console.log(`${label} - Read time for large file: ${(readEndTime - readStartTime).toFixed(2)} ms`);
    await promisify(storage, "flush");
    await validateLargeDataConsistency(storage._underlying, expectedData, t);
}

// Test for random-access-idb with large file consistency check
test('RandomAccessLayeredStorage file consistency test', { timeout: 60000000 }, async (t) => {
    const ras = defaultMaker('large-file-idb');
    await runLargeFileConsistencyTest(ras, 'random-access-idb', t);

    t.teardown(() => promisify(ras, 'unlink'));
});
