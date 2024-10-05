import { test } from "brittle";
import { performance } from 'perf_hooks';
import b4a from 'b4a'; // Buffer manipulation
import { promisify } from '../lib/util/promisify.js';
import 'fake-indexeddb/auto';
import { createFile } from "@zacharygriffee/random-access-idb";
import { RandomAccessLayeredStorage } from '../index.js';
import RAF from "random-access-file";
import RAM from "random-access-memory"; // Import RAM as a class

/**
 * Generates a random identifier string of specified length.
 * @param {number} length - Length of the identifier.
 * @returns {string} - Randomly generated identifier.
 */
function makeid(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
        counter += 1;
    }
    return result;
}

/**
 * Compares two buffers and returns an array of differences with their indexes.
 * @param {Buffer} bufferA - First buffer to compare.
 * @param {Buffer} bufferB - Second buffer to compare.
 * @returns {Array} - Array of difference objects.
 */
function compareBuffers(bufferA, bufferB) {
    const length = Math.min(bufferA.length, bufferB.length);
    const differences = [];
    for (let i = 0; i < length; i++) {
        if (bufferA[i] !== bufferB[i]) {
            differences.push({
                index: i,
                bufferAValue: bufferA[i],
                bufferBValue: bufferB[i],
            });
        }
    }
    if (bufferA.length !== bufferB.length) {
        const longerBuffer = bufferA.length > bufferB.length ? bufferA : bufferB;
        for (let i = length; i < longerBuffer.length; i++) {
            differences.push({
                index: i,
                bufferAValue: bufferA[i] || null,
                bufferBValue: bufferB[i] || null,
            });
        }
    }
    return differences;
}

/**
 * Validates the consistency of data in the storage against the expected data.
 * Logs detailed differences if inconsistencies are found.
 * @param {Object} storage - The storage instance to validate.
 * @param {Buffer} expectedData - The buffer containing expected data.
 * @param {Object} t - The test instance from Brittle.
 * @param {string} label - Label for the validation step.
 */
async function validateDataConsistency(storage, expectedData, t, label = '') {
    try {
        const length = expectedData.length;
        const actualData = await promisify(storage, 'read', 0, length);
        const differences = compareBuffers(actualData, expectedData);
        if (!b4a.equals(actualData, expectedData)) {
            console.error(`Differences found in ${label}:`, differences);
            console.error(`Expected Buffer (UTF-8): ${b4a.toString(expectedData, 'utf8')}`);
            console.error(`Actual Buffer (UTF-8):   ${b4a.toString(actualData, 'utf8')}`);
            t.fail(`${label} - Data inconsistency detected`);
        } else {
            // Optional: Uncomment the line below if you want to log successful validations
            // console.log(`${label} - Data is consistent.`);
            t.ok(true, `${label} - Data should be consistent after writes`);
        }
    } catch (error) {
        console.error(`Error during data consistency validation in ${label}:`, error);
        t.fail(`${label} - Data consistency validation failed with error: ${error.message}`);
    }
}

/**
 * Runs a merged stress test by performing write operations with varying access frequencies
 * and validating data consistency after each significant step.
 * @param {Object} storage - The storage instance to test.
 * @param {string} label - Label for the storage being tested.
 * @param {Object} t - The test instance from Brittle.
 * @param {number} [flushRate=5] - Number of iterations between flushes. Set to 0 to disable flushing during the test.
 */
async function runMergedStressTest(storage, label, t, flushRate = 5) {
    const iterations = 1000; // Total iterations
    const dataSize = 1024; // 1024 bytes per write
    const frequentAccessRate = 1; // Every iteration
    const occasionalAccessRate = flushRate; // Configurable flush rate
    const rareAccessRate = 50; // Every 50 iterations

    // Buffers filled with specific characters
    const frequentBuffer = b4a.alloc(dataSize, 'f'); // 'f' = 102
    const occasionalBuffer = b4a.alloc(dataSize, 'o'); // 'o' = 111
    const rareBuffer = b4a.alloc(dataSize, 'r'); // 'r' = 114

    // Calculate expected buffer size based on write patterns
    // Determine the maximum offset that will be written to
    let maxOffset = 0;
    for (let i = 0; i < iterations; i++) {
        const frequentOffset = i * dataSize;
        const occasionalOffset = (iterations + i) * dataSize;
        const rareOffset = (iterations * 2 + i) * dataSize;
        maxOffset = Math.max(maxOffset, frequentOffset, occasionalOffset, rareOffset);
    }
    const expectedBufferSize = maxOffset + dataSize; // Ensure buffer can accommodate the last write
    const expectedBuffer = b4a.alloc(expectedBufferSize, 0); // Initialize with 0s

    // Track the current maximum written offset
    let currentMaxOffset = 0;

    // Write data with different frequencies
    for (let i = 0; i < iterations; i++) {
        // Frequent data write
        const frequentOffset = i * dataSize;
        await promisify(storage, 'write', frequentOffset, frequentBuffer);
        // Use b4a.copy correctly: b4a.copy(source, target, targetStart)
        b4a.copy(frequentBuffer, expectedBuffer, frequentOffset);
        // Update currentMaxOffset
        currentMaxOffset = Math.max(currentMaxOffset, frequentOffset + dataSize);

        // Occasional data write
        if (i % occasionalAccessRate === 0 && flushRate > 0) {
            const occasionalOffset = (iterations + i) * dataSize;
            await promisify(storage, 'write', occasionalOffset, occasionalBuffer);
            b4a.copy(occasionalBuffer, expectedBuffer, occasionalOffset);
            // Update currentMaxOffset
            currentMaxOffset = Math.max(currentMaxOffset, occasionalOffset + dataSize);
        }

        // Rare data write
        if (i % rareAccessRate === 0 && flushRate > 0) {
            const rareOffset = (iterations * 2 + i) * dataSize;
            await promisify(storage, 'write', rareOffset, rareBuffer);
            b4a.copy(rareBuffer, expectedBuffer, rareOffset);
            // Update currentMaxOffset
            currentMaxOffset = Math.max(currentMaxOffset, rareOffset + dataSize);
        }

        // Intermediate validation every 'flushRate' iterations
        if (i % occasionalAccessRate === 0 && flushRate > 0) {
            const length = currentMaxOffset; // Validate only up to the current maximum written offset
            const expectedData = expectedBuffer.slice(0, length);
            if (typeof storage.flush === 'function') {
                // If flush is supported, ensure data is flushed
                const flushLength = typeof storage.size === 'number' ? storage.size : length;
                await promisify(storage, "flush", 0, flushLength);
            }
            // Perform validation without additional logs
            await validateDataConsistency(storage, expectedData, t, `${label} - Intermediate validation at iteration ${i}`);
        }
    }

    // Final consistency check
    if (typeof storage.flush === 'function') {
        const finalLength = currentMaxOffset; // Validate up to the final maximum written offset
        await promisify(storage, "flush", 0, finalLength);
    }
    // Perform final validation without additional logs
    await validateDataConsistency(storage, expectedBuffer.slice(0, currentMaxOffset), t, `${label} - Final consistency`);
}

/**
 * Helper function to introduce delay
 * @param {number} ms - Milliseconds to delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize a global object to store test durations
const testDurations = {};

// Register a listener to print test durations before the process exits
process.on('beforeExit', () => {
    console.log('\n=== Test Durations ===');
    for (const [testName, duration] of Object.entries(testDurations)) {
        console.log(`${testName}: ${duration.toFixed(3)}ms`);
    }
});

// Advanced Stress Test: random-access-memory (already working)
test('Advanced Stress Test: random-access-memory', { timeout: 600000 }, async (t) => {
    const ras = new RAM(); // Correctly instantiate RAM with new

    // Register teardown to ensure cleanup after the test
    t.teardown(async () => {
        try {
            if (typeof ras.close === 'function') await promisify(ras, 'close');
            if (typeof ras.unlink === 'function') await promisify(ras, 'unlink');
            await delay(6000);
            console.log('Teardown successful for random-access-memory');
        } catch (error) {
            console.error('Cleanup failed for random-access-memory:', error);
        }
    });

    // Capture start time
    const startTime = performance.now();

    await runMergedStressTest(ras, 'random-access-memory', t, 5); // Default flushRate

    // Capture end time and calculate duration BEFORE the delay
    const endTime = performance.now();
    const duration = endTime - startTime;
    testDurations['random-access-memory'] = duration;

    // Introduce a 3-second delay after the test
    await delay(3000);
});

// Advanced Stress Test: random-access-idb (adjusted)
test('Advanced Stress Test: random-access-idb', { timeout: 600000 }, async (t) => {
    const filename = `stress-test-idb-${makeid(10)}.txt`;
    const ras = createFile(filename); // Instantiate random-access-idb storage

    // Register teardown to ensure cleanup after the test
    t.teardown(async () => {
        try {
            await promisify(ras, 'unlink'); // Remove the file after the test
            await delay(6000);
            console.log('Teardown successful for random-access-idb');
        } catch (error) {
            console.error('Cleanup failed for random-access-idb:', error);
        }
    });

    // Capture start time
    const startTime = performance.now();

    // Adjust flushRate if necessary; for example, set to 10
    await runMergedStressTest(ras, 'random-access-idb', t, 10);

    // Capture end time and calculate duration BEFORE the delay
    const endTime = performance.now();
    const duration = endTime - startTime;
    testDurations['random-access-idb'] = duration;

});

// Advanced Stress Test: random-access-file (adjusted)
test('Advanced Stress Test: random-access-file', { timeout: 600000 }, async (t) => {
    const filename = `stress-test-file-${makeid(10)}.txt`;
    const ras = new RAF(filename, { size: 0, truncate: true }); // Instantiate random-access-file storage

    // Register teardown to ensure cleanup after the test
    t.teardown(async () => {
        try {
            await promisify(ras, 'unlink'); // Remove the file after the test
            await delay(6000);
            console.log('Teardown successful for random-access-file');
        } catch (error) {
            console.error('Cleanup failed for random-access-file:', error);
        }
    });

    // Capture start time
    const startTime = performance.now();

    // Adjust flushRate if necessary; for example, set to 10
    await runMergedStressTest(ras, 'random-access-file', t, 10);

    // Capture end time and calculate duration BEFORE the delay
    const endTime = performance.now();
    const duration = endTime - startTime;
    testDurations['random-access-file'] = duration;
});

// Stress Test: RandomAccessLayeredStorage with frequency of access (RAI)
test('Stress test: RandomAccessLayeredStorage with frequency of access RAI', { timeout: 600000 }, async (t) => {
    const filename = `stress-test-layered-rai-${makeid(10)}.txt`;
    const ras = createFile(filename); // Instantiate the base storage
    const layeredStorage = new RandomAccessLayeredStorage(ras); // Wrap with layered storage

    // Register teardown to ensure cleanup after the test
    t.teardown(async () => {
        try {
            await promisify(layeredStorage, 'unlink'); // Remove the layered storage
            await promisify(ras, 'unlink'); // Remove the base storage file
            // Introduce a 3-second delay after the test
            await delay(6000);
            console.log('Teardown successful for RandomAccessLayeredStorage(RAI)');
        } catch (error) {
            console.error('Cleanup failed for RandomAccessLayeredStorage(RAI):', error);
        }
    });

    // Capture start time
    const startTime = performance.now();

    // Disable intermediate flushes by setting flushRate to 0
    await runMergedStressTest(layeredStorage, 'RandomAccessLayeredStorage(RAI)', t, 0);

    // Perform a final flush
    try {
        await promisify(layeredStorage, 'flush', 0, layeredStorage.size);
        console.log('Final flush successful for RandomAccessLayeredStorage(RAI)');
    } catch (error) {
        console.error('Final flush failed for RandomAccessLayeredStorage(RAI):', error);
        t.fail('RandomAccessLayeredStorage(RAI) - Final flush failed');
    }

    // Read from the underlying storage
    try {
        const result = await promisify(layeredStorage._underlying, "read", 0, layeredStorage.size);

        // Validate the underlying storage after final flush
        await validateDataConsistency(layeredStorage._underlying, result, t, 'RandomAccessLayeredStorage(RAI) - Post-flush validation underlying storage');
    } catch (error) {
        console.error('Validation failed for underlying storage of RandomAccessLayeredStorage(RAI):', error);
        t.fail('RandomAccessLayeredStorage(RAI) - Underlying storage validation failed');
    }

    // Capture end time and calculate duration BEFORE the delay
    const endTime = performance.now();
    const duration = endTime - startTime;
    testDurations['RandomAccessLayeredStorage(RAI)'] = duration;


});

// Stress Test: RandomAccessLayeredStorage(RAF) with frequency of access RAF
test('Stress test: RandomAccessLayeredStorage(RAF) with frequency of access RAF', { timeout: 600000 }, async (t) => {
    const filename = `stress-test-layered-raf-${makeid(10)}.txt`;
    const ras = new RAF(filename, { size: 0, truncate: true }); // Instantiate the base storage
    const layeredStorage = new RandomAccessLayeredStorage(ras); // Wrap with layered storage

    // Register teardown to ensure cleanup after the test
    t.teardown(async () => {
        try {
            await promisify(layeredStorage, 'unlink'); // Remove the layered storage
            await promisify(ras, 'unlink'); // Remove the base storage file
            await delay(6000);
            console.log('Teardown successful for RandomAccessLayeredStorage(RAF)');
        } catch (error) {
            console.error('Cleanup failed for RandomAccessLayeredStorage(RAF):', error);
        }
    });

    // Capture start time
    const startTime = performance.now();

    // Disable intermediate flushes by setting flushRate to 0
    await runMergedStressTest(layeredStorage, 'RandomAccessLayeredStorage(RAF)', t, 0);

    // Perform a final flush
    try {
        await promisify(layeredStorage, 'flush', 0, layeredStorage.size);
        console.log('Final flush successful for RandomAccessLayeredStorage(RAF)');
    } catch (error) {
        console.error('Final flush failed for RandomAccessLayeredStorage(RAF):', error);
        t.fail('RandomAccessLayeredStorage(RAF) - Final flush failed');
    }

    // Read from the underlying storage
    try {
        const result = await promisify(layeredStorage._underlying, "read", 0, layeredStorage.size);

        // Validate the underlying storage after final flush
        await validateDataConsistency(layeredStorage._underlying, result, t, 'RandomAccessLayeredStorage(RAF) - Post-flush validation underlying storage');
    } catch (error) {
        console.error('Validation failed for underlying storage of RandomAccessLayeredStorage(RAF):', error);
        t.fail('RandomAccessLayeredStorage(RAF) - Underlying storage validation failed');
    }

    // Capture end time and calculate duration BEFORE the delay
    const endTime = performance.now();
    const duration = endTime - startTime;
    testDurations['RandomAccessLayeredStorage(RAF)'] = duration;

});

