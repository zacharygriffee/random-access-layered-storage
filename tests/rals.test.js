import { test, solo } from 'brittle';
import { RandomAccessLayeredStorage } from '../index.js';
import RAM from 'random-access-memory';
import b4a from 'b4a';
import RAF from 'random-access-file';
import RAI from "@zacharygriffee/random-access-idb";
import 'fake-indexeddb/auto';
import {promisify} from "../lib/util/promisify.js";
import {deferred} from "./utils/deferred.js";

export function makeid(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result;
}
const cleanupArray = [];
function cleanup(store, fn) {
    if (!store && !fn) {
        return Promise.all(cleanupArray.map(({fn, store}) => fn(store)));
    } else if (store) {
        fn ||= store => store.close();
        cleanupArray.push({fn, store});
    }
    return store;
}
// Helper function to write and read data
function writeAndRead(storage, offset, data, t, cb) {
    storage.write(offset, data, (err) => {
        t.is(err, null, 'No error on write');
        storage.read(offset, data.length, (err, readData) => {
            t.is(err, null, 'No error on read');
            t.alike(readData, data, 'Data read matches data written');
            cb();
        });
    });
}

// Set up test suite for multiple storage implementations
function testWithStorages(name, testFunc, soloTest) {
    const underlyingStorages = {
        RAM: () => cleanup(new RAM()),
        // Uncomment when needed for file-based testing
        RAF: () => cleanup(new RAF('test-file', {size: 1024}), async store => {
            await promisify(store, "close");
            await promisify(store, "unlink");
        }),
        Layered: () => cleanup(new RandomAccessLayeredStorage(new RAM())),
        RAI: () => cleanup(RAI("test-file" + makeid(20)), store => store.purge())
    };

    for (const [storageType, createStorage] of Object.entries(underlyingStorages)) {
        (soloTest ? solo : test)(`${name} - ${storageType}`, async (t) => {
            const underlyingStorage = createStorage();
            const storage = new RandomAccessLayeredStorage(underlyingStorage);
            await testFunc(t, storage, underlyingStorage);
        });
    }
}

// Rewriting all existing tests using testWithStorages

testWithStorages('Basic read and write', async (t, storage) => {
    t.plan(4);
    const data = b4a.from('Hello, world!');
    writeAndRead(storage, 0, data, t, () => {
        storage.close((err) => {
            t.is(err, null, 'No error on close');
        });
    });
});

testWithStorages('random access write and read', async (t, file) => {
    t.plan(8);

    const hiBuffer = b4a.from('hi');
    const helloBuffer = b4a.from('hello');

    // Step 1: Write 'hi' at offset 10
    file.write(10, hiBuffer, (err) => {
        t.absent(err, 'No error during first write');

        // Step 2: Write 'hello' at offset 0
        file.write(0, helloBuffer, (err) => {
            t.absent(err, 'No error during second write');

            // Step 3: Read 2 bytes from offset 10
            file.read(10, 2, (err, buf) => {
                t.absent(err, 'No error during first read');
                t.alike(buf, hiBuffer, 'First read matches "hi"');

                // Step 4: Read 5 bytes from offset 0
                file.read(0, 5, (err, buf) => {
                    t.absent(err, 'No error during second read');
                    t.alike(buf, helloBuffer, 'Second read matches "hello"');

                    // Step 5: Read 5 bytes from offset 5 (expecting zeros)
                    file.read(5, 5, (err, buf) => {
                        t.absent(err, 'No error during third read');
                        t.alike(buf, b4a.from([0, 0, 0, 0, 0]), 'Third read matches zeros');
                    });
                });
            });
        });
    });

    t.teardown(() => cleanup());
});


testWithStorages('Flush data to underlying storage', async (t, storage, underlyingStorage) => {
    t.plan(7);
    const data = b4a.from('Persistent data');
    writeAndRead(storage, 0, data, t, () => {
        storage.flush(0, data.length, (err) => {
            t.is(err, null, 'No error on flush');

            // Read from underlying storage directly
            underlyingStorage.read(0, data.length, (err, readData) => {
                t.is(err, null, 'No error on read from underlying storage');
                t.alike(readData, data, 'Underlying storage data matches');
                storage.close((err) => {
                    t.is(err, null, 'No error on close');
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('Evict pages without flushing', async (t, storage, underlyingStorage) => {
    t.plan(3);
    const data1 = b4a.from('Data1');
    const data2 = b4a.from('Data2');
    const data3 = b4a.from('Data3');

    storage.write(0, data1, (err) => {
        t.is(err, null, 'No error on write data1');

        storage.write(4, data2, (err) => {
            t.is(err, null, 'No error on write data2');

            storage.write(8, data3, (err) => {
                t.is(err, null, 'No error on write data3');

                // Evict pages without flushing
                storage.evict(1, false);

                // Data should not be in underlying storage
                // underlyingStorage.read(0, data1.length + data2.length + data3.length, (err) => {
                //     t.ok(err, 'Error expected when reading from underlying storage (data not flushed)');
                // });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('Evict pages with flushing', async (t, storage, underlyingStorage) => {
    t.plan(5);
    const data1 = b4a.from('Data1'); // 5 bytes
    const data2 = b4a.from('Data2'); // 5 bytes
    const data3 = b4a.from('Data3'); // 5 bytes

    storage.write(0, data1, (err) => {
        t.is(err, null, 'No error on write data1');

        storage.write(4, data2, (err) => {
            t.is(err, null, 'No error on write data2');

            storage.write(8, data3, (err) => {
                t.is(err, null, 'No error on write data3');

                // Evict pages with flushing and wait for completion
                storage.evict(1, true, () => {
                    // Data should be in underlying storage
                    const expectedData = b4a.from('DataDataData3');
                    const totalLength = expectedData.length;
                    underlyingStorage.read(0, totalLength, (err, readData) => {
                        t.is(err, null, 'No error on read from underlying storage');
                        t.alike(readData, expectedData, 'Underlying storage data matches');
                    });
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('Pinned pages are not evicted but can be modified and flushed', async (t, storage, underlyingStorage) => {
    t.plan(7);
    const data1 = b4a.from('Data1'); // 5 bytes
    const data2 = b4a.from('Data2'); // 5 bytes

    storage.write(0, data1, (err) => {
        t.is(err, null, 'No error on write data1');

        // Pin the pages occupied by data1
        storage.pin(0, data1.length);

        // Write data2 at an overlapping position
        storage.write(4, data2, (err) => {
            t.is(err, null, 'No error on write data2');

            // Flush the pages
            storage.flush(0, data1.length + data2.length, (err) => {
                t.is(err, null, 'No error on flush');

                // Ensure that data1 is still in memory and matches the modification
                storage.read(0, data1.length, (err, readData) => {
                    t.is(err, null, 'No error on read pinned data');
                    t.alike(readData, b4a.from('DataD'), 'Pinned data is modified but not evicted');

                    // Attempt to evict the page and ensure it doesn't get evicted
                    storage.evict(1, false, () => {
                        // Data should still be in the overlay
                        storage.read(0, data1.length, (err, readData) => {
                            t.is(err, null, 'No error on read pinned data after eviction');
                            t.alike(readData, b4a.from('DataD'), 'Pinned data remains in the overlay');
                        });
                    });
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('Bitmask controls modifications', async (t, storage) => {
    t.plan(9);
    const data = b4a.from('Hello, world!');
    const bitmask = b4a.alloc(Math.ceil(data.length / 8), 0xFF); // All bits set

    storage.setBitmask(bitmask);

    storage.write(0, data, (err) => {
        t.is(err, null, 'No error on write with bitmask');

        // Clear bitmask to prevent modifications
        storage.clearBitmask();
        storage.write(0, b4a.from('XXXXX'), (err) => {
            t.is(err, null, 'No error on write without bitmask');

            // Read data back
            storage.read(0, data.length, (err, readData) => {
                t.is(err, null, 'No error on read');
                t.alike(readData.slice(0, 5), b4a.from('XXXXX'), 'First 5 bytes modified');
                t.alike(readData.slice(5), data.slice(5), 'Remaining bytes unchanged');

                storage.setBitmask(bitmask);
                storage.write(0, b4a.from('!!!!!'), (err) => {
                    t.is(err, null, 'No error on write with bitmask');

                    storage.read(0, data.length, (err, readData) => {
                        t.is(err, null, 'No error on read after bitmask write');
                        t.alike(readData.slice(0, 5), b4a.from('!!!!!'), 'First 5 bytes modified again');
                        t.alike(readData.slice(5), data.slice(5), 'Remaining bytes unchanged');
                    });
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('Strict size enforcement', async (t, storage, underlyingStorage) => {
    t.plan(3);

    // Enforce strict size limit
    const strictStorage = new RandomAccessLayeredStorage(underlyingStorage, {
        strictSizeEnforcement: 10,
    });

    const data = b4a.from('1234567890');
    strictStorage.write(0, data, (err) => {
        t.is(err, null, 'No error on write within size limit');

        strictStorage.write(10, b4a.from('X'), (err) => {
            t.ok(err, 'Error expected on write exceeding size limit');
            t.is(err.message, 'Write exceeds strict size enforcement', 'Correct error message on size enforcement');
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('Truncate storage', async (t, storage) => {
    t.plan(4);
    const data = b4a.from('Hello, world!');
    storage.write(0, data, (err) => {
        t.is(err, null, 'No error on write');

        storage.truncate(5, (err) => {
            t.is(err, null, 'No error on truncate');

            storage.read(0, 5, (err, readData) => {
                t.is(err, null, 'No error on read after truncate');
                t.alike(readData, data.slice(0, 5), 'Data matches truncated size');

                // storage.read(5, 1, (err) => {
                //     t.ok(err, 'Error expected when reading beyond truncated size');
                // });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages("delete", async (t, file) => {
    t.plan(6)

    // const pageSize = 1024
    // const file = storage({ pageSize })

    // identify bug in deletion when file.length > 2 * page size
    const orig = b4a.alloc(1024 * 3, 0xff)
    const expected = b4a.alloc(10, 0xff)

    file.write(0, orig, function (err) {
        t.absent(err, 'no error')
        file.read(0, file.length, function (err, buf) {
            t.absent(err, 'no error')
            t.alike(buf, orig)
            file.del(10, Infinity, function (err) {
                t.absent(err, 'no error')
                file.read(0, file.length, function (err, buf) {
                    t.absent(err, 'no error')
                    t.alike(buf, expected)
                })
            })
        })
    });
    t.teardown(() => cleanup());
})

testWithStorages('truncate grows file', async (t, file) => {
    t.plan(5);

    const initialSize = 1024; // Initial file size
    const growSize = 2048;    // New size after truncate
    const data = b4a.alloc(initialSize, 0xff); // Fill with 0xff
    const expectedGrow = b4a.alloc(growSize - initialSize, 0x00); // Fill the grown part with zeroes

    // Step 1: Write initial data
    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        // Step 2: Truncate to grow the file size
        file.truncate(growSize, (err) => {
            t.absent(err, 'No error during truncate to grow');

            // Step 3: Read the entire file after growth
            file.read(0, growSize, (err, buf) => {
                t.absent(err, 'No error during read after growth');
                t.alike(buf.subarray(0, initialSize), data, 'Initial data remains intact');
                t.alike(buf.subarray(initialSize), expectedGrow, 'Newly grown part is zero-filled');
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('truncate grows, flushes, and checks underlying storage', async (t, file, underlyingStorage) => {
    t.plan(8);

    const initialSize = 1024; // Initial file size
    const growSize = 2048;    // New size after truncate
    const data = b4a.alloc(initialSize, 0xff); // Fill with 0xff
    const expectedGrow = b4a.alloc(growSize - initialSize, 0x00); // Fill the grown part with zeroes

    // Step 1: Write initial data
    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        // Step 2: Truncate to grow the file size
        file.truncate(growSize, (err) => {
            t.absent(err, 'No error during truncate to grow');

            // Step 3: Flush the changes to the underlying storage
            file.flush(0, growSize, (err) => {
                t.absent(err, 'No error during flush after growth');

                // Step 4: Verify that the underlying storage also grew
                underlyingStorage.stat((err, stats) => {
                    t.absent(err, 'No error during stat on underlying storage');
                    t.ok(stats.size >= growSize, 'Underlying storage size matches or exceeds grow size');

                    // Step 5: Read the entire file from underlying storage
                    underlyingStorage.read(0, growSize, (err, buf) => {
                        t.absent(err, 'No error during read from underlying storage');
                        t.alike(buf.subarray(0, initialSize), data, 'Initial data remains intact in underlying storage');
                        t.alike(buf.subarray(initialSize), expectedGrow, 'Newly grown part is zero-filled in underlying storage');
                    });
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('truncate shrinks and checks in-memory storage', async (t, file) => {
    t.plan(6);

    const initialSize = 2048; // Initial file size
    const shrinkSize = 1024;  // New size after truncate
    const data = b4a.alloc(initialSize, 0xff); // Fill with 0xff

    // Step 1: Write initial data
    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        // Step 2: Truncate to shrink the file size
        file.truncate(shrinkSize, (err) => {
            t.absent(err, 'No error during truncate to shrink');

            // Step 3: Check the new size in memory
            file.stat((err, stats) => {
                t.absent(err, 'No error during stat after shrink');
                t.is(stats.size, shrinkSize, 'File size reflects shrink in memory');

                // Step 4: Ensure that reading beyond the truncated size returns zero-filled data
                file.read(shrinkSize, 1024, (err, buf) => {
                    t.absent(err, 'No error during read after shrinking');
                    t.ok(buf.every((byte) => byte === 0), 'Read beyond shrunk size is zero-filled');
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('truncate shrinks, flushes, and checks underlying storage', async (t, file, underlyingStorage) => {
    t.plan(7);

    const initialSize = 2048; // Initial file size
    const shrinkSize = 1024;  // New size after truncate
    const data = b4a.alloc(initialSize, 0xff); // Fill with 0xff

    // Step 1: Write initial data
    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        // Step 2: Truncate to shrink the file size
        file.truncate(shrinkSize, (err) => {
            t.absent(err, 'No error during truncate to shrink');

            // Step 3: Flush the changes to the underlying storage
            file.flush(0, shrinkSize, (err) => {
                t.absent(err, 'No error during flush after shrink');

                // Step 4: Verify that the underlying storage also shrunk
                underlyingStorage.stat((err, stats) => {
                    t.absent(err, 'No error during stat on underlying storage');
                    t.ok(stats.size <= shrinkSize, 'Underlying storage size reflects the shrink size');

                    // Step 5: Read the entire file from underlying storage
                    underlyingStorage.read(0, shrinkSize, (err, buf) => {
                        t.absent(err, 'No error during read from underlying storage');
                        t.alike(buf, data.subarray(0, shrinkSize), 'Underlying storage data matches after shrink');
                    });
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('delete and checks in-memory storage', async (t, file) => {
    t.plan(6);

    const initialSize = 2048; // Initial file size
    const deleteOffset = 1024; // Start deletion at 1024 bytes
    const deleteSize = 1024;   // Delete the last 1024 bytes
    const data = b4a.alloc(initialSize, 0xff); // Fill with 0xff

    // Step 1: Write initial data
    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        // Step 2: Delete a range of bytes
        file.del(deleteOffset, deleteSize, (err) => {
            t.absent(err, 'No error during delete operation');

            // Step 3: Check that the data up to the delete offset remains intact
            file.read(0, deleteOffset, (err, buf) => {
                t.absent(err, 'No error during read before delete offset');
                t.alike(buf, data.subarray(0, deleteOffset), 'Data before delete offset is intact');

                // Step 4: Ensure the deleted section is zero-filled in memory
                file.read(deleteOffset, deleteSize, (err, buf) => {
                    t.absent(err, 'No error during read after delete');
                    t.ok(buf.every((byte) => byte === 0), 'Deleted section is zero-filled in memory');
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('delete, flush, and checks underlying storage', async (t, file, underlyingStorage) => {
    t.plan(7); // Adjust the number of planned assertions

    const initialSize = 2048; // Initial file size
    const deleteOffset = 1024; // Start deletion at 1024 bytes
    const deleteSize = 1024;   // Delete the last 1024 bytes
    const data = b4a.alloc(initialSize, 0xff); // Fill with 0xff

    // Step 1: Write initial data
    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        // Step 2: Delete a range of bytes
        file.del(deleteOffset, deleteSize, (err) => {
            t.absent(err, 'No error during delete operation');

            // Step 3: Flush the changes to the underlying storage
            file.flush(0, initialSize, (err) => {
                t.absent(err, 'No error during flush after delete');

                // Step 4: Check the underlying storage before the delete offset
                underlyingStorage.read(0, deleteOffset, (err, buf) => {
                    t.absent(err, 'No error during read from underlying storage before delete');
                    t.alike(buf, data.subarray(0, deleteOffset), 'Data before delete offset matches in underlying storage');

                    // Step 5: Ensure that the deleted section is zero-filled in the underlying storage or handle the error for other storages
                    underlyingStorage.read(deleteOffset, deleteSize, (err, buf) => {
                        // note: messages differ between standard RAS and RAI,
                        //       need to correct RAI message here.
                        if (err && err.message.includes('Could not satisfy length') ) {
                            t.pass('Expected error when reading beyond the file size in the underlying storage');
                            t.pass("Even the assertion level");
                        } else {
                            t.absent(err, 'No error during read from deleted section in underlying storage');
                            t.ok(buf?.every((byte) => byte === 0), 'Deleted section is zero-filled in underlying storage');
                        }
                    });
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('concurrent reads and writes', async (t, file) => {
    t.plan(4);
    const data1 = b4a.from('First data block');
    const data2 = b4a.from('Second data block');
    const readSize = 1024;

    file.write(0, data1, (err) => {
        t.absent(err, 'No error during first write');

        file.write(0, data2, (err) => {
            t.absent(err, 'No error during second write');
        });

        file.read(0, readSize, (err, buf) => {
            t.absent(err, 'No error during concurrent read');
            t.alike(buf.slice(0, data2.length), data2, 'Read data matches second write block');
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('edge case truncate', async (t, file) => {
    t.plan(4);
    const data = b4a.from('Test truncation edge case data');

    file.write(0, data, (err) => {
        t.absent(err, 'No error during write');

        file.truncate(1, (err) => {
            t.absent(err, 'No error during truncation');

            file.read(0, 1024, (err, buf) => {
                t.absent(err, 'No error during read after truncate');
                t.is(buf[0], data[0], 'First byte remains after truncate');
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('partial page flush', async (t, file) => {
    t.plan(4);
    const data = b4a.alloc(1024 * 2, 0xff);

    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        file.flush(512, 1024, (err) => {
            t.absent(err, 'No error during partial page flush');

            file.read(0, 1024, (err, buf) => {
                t.absent(err, 'No error during read after partial flush');
                t.alike(buf, data.slice(0, 1024), 'Data matches after partial page flush');
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('eviction after write with layered behavior', async (t, file, underlyingStorage) => {
    const { promise, resolve } = deferred();
    const data = b4a.alloc(2048, 0xff);

    // Step 1: Write data to the file
    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        // Evict the page(s) from memory without flushing to the underlying storage
        file.evict(1, false, (err) => {
            t.absent(err, 'No error during eviction');

            // Step 2: Try to read from the evicted file
            file.read(0, 1024, (err, buf) => {
                if (err) {
                    // Case where eviction causes read error (expected for RAM/RAF)
                    t.ok(err, 'Expected error due to eviction without flush');
                    resolve();
                } else {
                    // Case where eviction doesn't cause read error (expected for layered storage)
                    t.absent(err, 'No error during read after eviction');
                    t.alike(buf, b4a.alloc(1024, 0x00), 'Read returns zeros after eviction in layered storage');
                    // Step 3: Validate underlying storage after eviction
                    underlyingStorage.read(0, 1024, (err, buf) => {
                        if (err) {
                            t.ok(err, 'Expected error from underlying storage due to lack of flush');
                        } else {
                            // For layered storage, RAM remains zeroed due to no flush, so we check for zeros
                            t.alike(buf, b4a.alloc(1024, 0x00), 'Underlying storage is zero-filled as expected');
                        }
                        resolve();
                    });
                }
            });
        });
    });

    await promise;
    t.teardown(() => cleanup());
});

testWithStorages('pinned page handling', async (t, file) => {
    t.plan(4);
    const data = b4a.alloc(1024, 0xff);

    file.write(0, data, (err) => {
        t.absent(err, 'No error during write');

        file.pin(0, 1024);
        file.evict(1, false, (err) => {
            t.absent(err, 'No error during eviction with pinned page');

            file.read(0, 1024, (err, buf) => {
                t.absent(err, 'No error during read after eviction with pinned page');
                t.alike(buf, data, 'Pinned page remains intact after eviction');
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('simulated power failure during flush', async (t, file) => {
    t.plan(4);
    const data = b4a.alloc(1024, 0xff);

    file.write(0, data, (err) => {
        t.absent(err, 'No error during write');

        // Simulate power failure by forcing a callback exit during flush
        const originalFlush = file.flush;
        file.flush = function(offset, size, callback) {
            return setTimeout(() => {
                file.flush = originalFlush; // Restore the flush after simulated failure
                callback(new Error('Simulated power failure'));
            }, 50);
        };

        file.flush(0, 1024, (err) => {
            t.ok(err, 'Simulated power failure occurred during flush');

            file.read(0, 1024, (err, buf) => {
                t.absent(err, 'No error during read after simulated failure');
                t.alike(buf, data, 'Data remains intact after simulated failure');
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('write and delete beyond file size', async (t, file) => {
    t.plan(5);
    const data = b4a.alloc(1024, 0xff);

    file.write(1024, data, (err) => {
        t.absent(err, 'No error during write beyond file size');

        file.del(2048, 1024, (err) => {
            t.absent(err, 'No error during delete beyond file size');

            file.flush(0, 3072, (err) => {
                t.absent(err, 'No error during flush after write and delete beyond file size');

                file.read(1024, 1024, (err, buf) => {
                    t.absent(err, 'No error during read after write beyond file size');
                    t.alike(buf, data, 'Data matches written block beyond file size');
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

testWithStorages('resize with flush', async (t, file) => {
    t.plan(7); // We added an additional check for zero-fill after growth
    const data = b4a.alloc(64, 0xff);

    file.write(0, data, (err) => {
        t.absent(err, 'No error during initial write');

        file.truncate(32, (err) => {
            t.absent(err, 'No error during shrink');

            file.flush(0, 64, (err) => {
                t.absent(err, 'No error during flush after resize');

                file.truncate(128, (err) => {
                    t.absent(err, 'No error during grow');

                    file.read(0, 64, (err, buf) => {
                        t.absent(err, 'No error during read after grow');
                        t.alike(buf.slice(0, 32), data.slice(0, 32), 'First 32 bytes match after grow');
                        t.ok(buf.slice(32).every(byte => byte === 0), 'Remaining bytes after grow are zero-filled');
                    });
                });
            });
        });
    });
    t.teardown(() => cleanup());
});

// testWithStorages('Multiple storage layers', async (t, storage, intermediateStorage) => {
//     t.plan(5);
//     const data = b4a.from('Layered data');
//
//     // Ensure the intermediate storage is a RandomAccessLayeredStorage
//     const wrappedIntermediateStorage = new RandomAccessLayeredStorage(intermediateStorage);
//
//     // Open storages explicitly
//     storage.open((err) => {
//         if (err) return t.fail('Failed to open top layer');
//         wrappedIntermediateStorage.open((err) => {
//             if (err) return t.fail('Failed to open intermediate layer');
//
//             storage.write(0, data, (err) => {
//                 t.is(err, null, 'No error on write to top layer');
//
//                 storage.flush(0, data.length, (err) => {
//                     t.is(err, null, 'No error on flush to intermediate layer');
//                     if (err) return;
//
//                     wrappedIntermediateStorage.flush(0, data.length, (err) => {
//                         t.is(err, null, 'No error on flush to underlying storage');
//                         if (err) return;
//
//                         wrappedIntermediateStorage.read(0, data.length, (err, readData) => {
//                             t.is(err, null, 'No error on read from underlying storage');
//                             console.log('Data from underlying storage:', readData); // Add this line
//                             t.alike(readData, data, 'Data matches across all layers');
//                         });
//                     });
//                 });
//             });
//         });
//     });
// }, true);

