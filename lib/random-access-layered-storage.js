import RAS from 'random-access-storage';
import b4a from 'b4a';
import { LRUCache } from 'lru-cache';

/**
 * RandomAccessLayeredStorage
 * Provides a memory overlay over any random-access-storage implementation.
 */
export class RandomAccessLayeredStorage extends RAS {
    constructor(underlyingStorage, opts = {}) {
        super(opts);

        // Underlying storage (e.g., RAM, RAF, IndexedDB)
        this._underlying = underlyingStorage;

        // Configuration options
        this.pageSize = opts.pageSize || 1024 * 1024; // Default 1MB pages
        this.maxPages = opts.maxPages || 100; // Max pages in memory
        this._createIfMissing = opts.createIfMissing !== undefined ? opts.createIfMissing : true;
        this._strictSizeLimit = opts.strictSizeEnforcement;
        this._flushOnClose = opts.flushOnClose !== undefined ? opts.flushOnClose : true;
        this._autoFlushOnEvict = opts.autoFlushOnEvict !== undefined ? opts.autoFlushOnEvict : true;
        this._opts = opts;

        // Pass the strictSizeEnforcement to the underlying storage if it's another layered storage
        if (underlyingStorage instanceof RandomAccessLayeredStorage) {
            underlyingStorage._strictSizeLimit = this._strictSizeLimit;
        }


        // In-memory overlay data structures
        this._pages = new Map(); // pageIndex -> { data, modified, pinned }
        this._lru = new LRUCache({
            max: this.maxPages,
            dispose: this._onEvict.bind(this),
            noDisposeOnSet: true,
        });
        this._pinnedPages = new Set(); // Set of pinned page indices

        // Bitmask for modification control
        this._bitmask = null; // Buffer

        // File metadata
        this._size = 0; // Size of the overlay
        this._fileExists = false; // Whether the file exists in the underlying storage

        // Access times for LRU eviction
        this._accessTimes = new Map();

        // Modified pages tracking
        this._modifiedPages = new Set();

        // Initialize readable, writable, etc., based on the implemented methods
        this.readable = true;
        this.writable = true;
        this.deletable = true;
        this.truncatable = true;
        this.statable = true;
        this.destroyable = true;
    }

    get length() {
        return this._size;
    }

    get size() {
        return this._size;
    }

    /**
     * Implement storage open.
     * req.create is true if the storage should be created.
     * Call req.callback when it is fully opened.
     */
    _open(req) {
        if (this.opened || this.opening) {
            return req.callback(null);
        }
        this.opening = true;

        const handleOpen = (err) => {
            if (err) {
                this.opening = false;
                return req.callback(err);
            }

            // File exists; get its size
            this._fileExists = true;
            if (typeof this._underlying.stat === 'function') {
                this._underlying.stat((err, stats) => {
                    if (err) {
                        // Handle the case where the file doesn't exist
                        this._size = 0;  // Default to size 0 for non-existing files
                        this.opened = true;
                        this.opening = false;
                        return req.callback(null, { size: 0 });
                    }
                    this._size = Math.max(this._size, stats.size);
                    this.opened = true;
                    this.opening = false;
                    req.callback(null);
                });
            } else {
                this.opened = true;
                this.opening = false;
                req.callback(null);
            }
        };

        // Open the underlying storage
        if (typeof this._underlying.open === 'function') {
            this._underlying.open((err) => {
                if (err) {
                    this.opening = false;
                    return req.callback(err);
                }
                handleOpen(null);
            });
        } else {
            handleOpen(null);
        }
    }


    /**
     * Implement storage read.
     * req.offset contains the byte offset to read at.
     * req.size contains the amount of bytes to read.
     * Call req.callback(err, buffer) when the read is completed.
     */
    _read(req) {
        this._ensureOpen((err) => {
            if (err) return req.callback(err);

            if (!this._fileExists) {
                // If the file doesn't exist and createIfMissing is false
                return req.callback(new Error('File does not exist'));
            }

            if (this._strictSizeLimit !== undefined && req.offset + req.size > this._strictSizeLimit) {
                return req.callback(new Error('Read exceeds strict size enforcement'));
            }

            const buffer = b4a.alloc(req.size, 0); // Pre-fill the buffer with null bytes
            let bytesRead = 0;
            let offset = req.offset;

            const readNext = () => {
                if (bytesRead >= req.size) {
                    return req.callback(null, buffer);
                }

                const pageIndex = Math.floor(offset / this.pageSize);
                const pageOffset = offset % this.pageSize;
                const bytesToRead = Math.min(this.pageSize - pageOffset, req.size - bytesRead);

                this._getPage(pageIndex, (err, page) => {
                    if (err && err.message.includes('Read exceeds storage size')) {
                        // If the read exceeds storage size, fill with null bytes (already done in buffer)
                        bytesRead += bytesToRead;
                        offset += bytesToRead;
                        return setImmediate(readNext);
                    }

                    if (err) return req.callback(err);

                    buffer.set(page.data.subarray(pageOffset, pageOffset + bytesToRead), bytesRead);

                    // Update LRU and access time
                    this._touchPage(pageIndex);

                    bytesRead += bytesToRead;
                    offset += bytesToRead;

                    setImmediate(readNext);
                });
            };

            readNext();
        });
    }


    /**
     * Implement storage write.
     * req.offset contains the byte offset to write at.
     * req.data contains the buffer to write.
     * Call req.callback(err) when the write is completed.
     */
    // Fix in RandomAccessLayeredStorage.js
    _write(req) {
        console.log(`Write called on storage at offset ${req.offset}, size ${req.data.length}`);
        this._ensureOpen((err) => {
            if (err) return req.callback(err);

            if (this._strictSizeLimit !== undefined && req.offset + req.data.length > this._strictSizeLimit) {
                return req.callback(new Error('Write exceeds strict size enforcement'));
            }

            let bytesWritten = 0;
            let offset = req.offset;

            const writeNext = () => {
                if (bytesWritten >= req.data.length) {
                    // Update overlay size
                    this._size = Math.max(this._size, req.offset + req.data.length);
                    return req.callback(null);
                }

                const pageIndex = Math.floor(offset / this.pageSize);
                const pageOffset = offset % this.pageSize;
                const bytesToWrite = Math.min(this.pageSize - pageOffset, req.data.length - bytesWritten);

                // Check bitmask if applicable
                if (this._bitmask && !this._isBitSet(offset, bytesToWrite)) {
                    bytesWritten += bytesToWrite;
                    offset += bytesToWrite;
                    setImmediate(writeNext);
                    return;
                }

                // Write to the page, handle pinned and unpinned
                this._getOrCreatePage(pageIndex, (err, page) => {
                    if (err) return req.callback(err);

                    // Ensure the page buffer can accommodate the data
                    if (page.data.length < pageOffset + bytesToWrite) {
                        const newPageData = b4a.alloc(pageOffset + bytesToWrite, 0); // Zero-filled buffer for growth
                        page.data.copy(newPageData);
                        page.data = newPageData;
                    }

                    // Mark page as modified
                    page.data.set(req.data.subarray(bytesWritten, bytesWritten + bytesToWrite), pageOffset);
                    page.modified = true;
                    this._modifiedPages.add(pageIndex);

                    // If the page is not pinned, make sure it's managed in LRU
                    if (!this._pinnedPages.has(pageIndex)) {
                        this._touchPage(pageIndex);
                    }

                    bytesWritten += bytesToWrite;
                    offset += bytesToWrite;

                    setImmediate(writeNext);
                });
            };

            writeNext();
        });
    }


    /**
     * Implement storage delete.
     * @param {object} req - The delete request containing the offset and size.
     * @param {function} req.callback - The callback to call when done.
     */
    _del(req) {
        this._ensureOpen((err) => {
            if (err) return req.callback(err);

            let bytesDeleted = 0;
            let offset = req.offset;
            const end = req.size === Infinity || (req.offset + req.size) > this._size
                ? this._size // Truncate the file if size + offset exceeds file size
                : req.offset + req.size;

            const deleteNext = () => {
                if (bytesDeleted >= end - req.offset) {
                    if (end === this._size) {
                        // Truncate the file at the offset if end equals file size
                        this._size = req.offset;
                    }
                    return req.callback(null);
                }

                const pageIndex = Math.floor(offset / this.pageSize);
                const pageOffset = offset % this.pageSize;
                const bytesToDelete = Math.min(this.pageSize - pageOffset, end - offset);

                this._getPage(pageIndex, (err, page) => {
                    if (page) {
                        page.data.fill(0, pageOffset, pageOffset + bytesToDelete);
                        page.modified = true;
                        this._modifiedPages.add(pageIndex);
                    }

                    proceed();

                    function proceed() {
                        bytesDeleted += bytesToDelete;
                        offset += bytesToDelete;
                        setImmediate(deleteNext);
                    }
                });
            };

            deleteNext();
        });
    }




    /**
     * Implement storage truncate.
     * @param {object} req - The truncate request containing the offset.
     * @param {function} req.callback - The callback to call when done.
     */
    _truncate(req) {
        this._ensureOpen((err) => {
            if (err) return req.callback(err);

            const newSize = req.offset;

            if (newSize > this._size) {
                // Growing the file: extend it with zeroes using the public write method
                const bytesToGrow = newSize - this._size;
                const growBuffer = b4a.alloc(bytesToGrow, 0); // Fill with zeroes

                this.write(this._size, growBuffer, (err) => {
                    if (err) return req.callback(err);
                    this._size = newSize;
                    req.callback(null);
                });
            } else {
                // Shrinking the file
                this._size = newSize;

                // Remove pages beyond the new size
                const pageIndex = Math.floor(newSize / this.pageSize);
                const pagesToRemove = [...this._pages.keys()].filter((index) => index > pageIndex);
                for (const index of pagesToRemove) {
                    this._pages.delete(index);
                    this._lru.delete(index);
                    this._modifiedPages.delete(index);
                    this._pinnedPages.delete(index);
                }

                // Adjust the last page if necessary
                const lastPage = this._pages.get(pageIndex);
                if (lastPage) {
                    const newPageSize = newSize % this.pageSize;
                    if (newPageSize === 0) {
                        // Remove the page if size is exactly a page boundary
                        this._pages.delete(pageIndex);
                        this._lru.delete(pageIndex);
                        this._modifiedPages.delete(pageIndex);
                        this._pinnedPages.delete(pageIndex);
                    } else {
                        // Truncate the last page's data
                        lastPage.data = lastPage.data.subarray(0, newPageSize);
                        lastPage.modified = true;
                        this._modifiedPages.add(pageIndex);
                    }
                }

                // Perform the truncation on the underlying storage if supported
                if (this._supports('truncate')) {
                    this._underlying.truncate(newSize, (err) => {
                        if (err) return req.callback(err);
                        req.callback(null);
                    });
                } else {
                    req.callback(null);
                }
            }
        });
    }


    /**
     * Implement storage stat.
     * Call req.callback(err, statObject) when the stat has completed.
     */
    _stat(req) {
        this._ensureOpen((err) => {
            if (err) return req.callback(err);

            req.callback(null, { size: this._size });
        });
    }

    /**
     * Implement storage close.
     * Call req.callback(err) when the storage is fully closed.
     */
    _close(req) {
        const proceed = () => {
            const finishClose = () => {
                if (this._supports('close')) {
                    this._underlying.close((err) => {
                        if (err) return req.callback(err);
                        this.closed = true;
                        req.callback(null);
                    });
                } else {
                    this.closed = true;
                    req.callback(null);
                }
            };
            if (this._flushOnClose) {
                this.flush(0, this._size, (err) => {
                    if (err) {
                        console.error('Error during flush on close:', err);
                        // Decide whether to proceed or return the error
                        // For now, let's proceed with closing
                    }
                    finishClose();
                });
            } else {
                finishClose();
            }
        };

        if (this.opened) {
            proceed();
        } else {
            this._ensureOpen((err) => {
                if (err) return req.callback(err);
                proceed();
            });
        }
    }


    /**
     * Implement storage unlink.
     * Call req.callback(err) when the storage has been fully unlinked.
     */
    _unlink(req) {
        this._ensureOpen((err) => {
            if (err) return req.callback(err);

            const proceed = () => {
                if (this._supports('unlink')) {
                    this._underlying.unlink((err) => {
                        if (err) return req.callback(err);
                        this.unlinked = true;
                        req.callback(null);
                    });
                } else {
                    // If unlink not supported, simulate unlink
                    this._pages.clear();
                    this._lru.clear();
                    this._modifiedPages.clear();
                    this._pinnedPages.clear();
                    this._size = 0;
                    this.unlinked = true;
                    req.callback(null);
                }
            };

            if (this.opened) {
                proceed();
            } else {
                this._ensureOpen((err) => {
                    if (err) return req.callback(err);
                    proceed();
                });
            }
        });
    }

    /**
     * Flush modified pages to the underlying storage.
     * @param {number} [offset=0] - The byte offset to start flushing from.
     * @param {number} [size=this._size] - The number of bytes to flush.
     * @param {function} callback - The callback to call when done.
     */
    flush(offset = 0, size = this._size, callback) {
        this._ensureOpen((err) => {
            if (err) return callback(err);

            // Adjust flush size to not exceed current size
            size = Math.min(size, this._size);

            // Ensure underlying storage is open
            if (typeof this._underlying._ensureOpen === 'function') {
                this._underlying._ensureOpen((err) => {
                    if (err) return callback(err);
                    this._performFlush(offset, size, callback); // Use adjusted size
                });
            } else {
                this._performFlush(offset, size, callback); // Use adjusted size
            }
        });
    }



    /**
     * Performs the actual flushing process of the data from memory to underlying storage.
     * @param {number} offset - The byte offset to start flushing from.
     * @param {number} size - The number of bytes to flush.
     * @param {function} callback - The callback to call when done.
     */
    _performFlush(offset, size, callback) {
        const end = offset + size;
        const startPage = Math.floor(offset / this.pageSize);
        const endPage = Math.floor((end - 1) / this.pageSize);

        const pagesToFlush = [];
        for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
            pagesToFlush.push(pageIndex);
        }

        let index = 0;

        const flushNext = () => {
            if (index >= pagesToFlush.length) {
                // After writing all pages, check if we need to truncate the underlying storage
                if (this._size < end && this._supports('truncate')) {
                    this._underlying.truncate(this._size, (err) => {
                        if (err) return callback(err);
                        callback(null);
                    });
                } else {
                    callback(null);
                }
                return;
            }

            const pageIndex = pagesToFlush[index++];
            const pageOffset = pageIndex * this.pageSize;
            const startOffsetInPage = (pageIndex === startPage) ? (offset % this.pageSize) : 0;
            const endOffsetInPage = (pageIndex === endPage) ? ((end - 1) % this.pageSize) + 1 : this.pageSize;
            const writeSize = endOffsetInPage - startOffsetInPage;

            const page = this._pages.get(pageIndex);
            const bufferToWrite = page
                ? page.data.subarray(startOffsetInPage, endOffsetInPage)
                : b4a.alloc(writeSize, 0); // Fill with zeroes if page doesn't exist

            this._underlying.write(pageOffset + startOffsetInPage, bufferToWrite, (err) => {
                if (err) return callback(err);

                if (page && page.modified) {
                    page.modified = false;
                    this._modifiedPages.delete(pageIndex);
                }

                setImmediate(flushNext);
            });
        };

        flushNext();
    }


    /**
     * Handles overlaying the in-memory page data and writing to the underlying storage.
     */
    _overlayAndWrite(pageIndex, startOffsetInPage, endOffsetInPage, bufferToWrite, callback, flushNext) {
        const page = this._pages.get(pageIndex);
        if (page) {
            // Overlay modified data from page into the buffer
            page.data.copy(bufferToWrite, 0, startOffsetInPage, endOffsetInPage);
        }

        // Write the buffer back to underlying storage
        this._underlying.write(pageIndex * this.pageSize + startOffsetInPage, bufferToWrite, (err) => {
            if (err) return callback(err);

            // Mark the page as flushed if it was modified
            if (page && page.modified) {
                page.modified = false;
                this._modifiedPages.delete(pageIndex);
            }

            setImmediate(flushNext);
        });
    }


    /**
     * Evicts pages from the overlay.
     * If flushBeforeEvict is true, flushes modified pages before eviction.
     */
    evict(percent = 1, flushBeforeEvict = false, callback = () => {}) {
        const totalPages = this._lru.size;
        const pagesToEvict = Math.ceil(totalPages * percent);

        // Get least recently used pages, excluding pinned ones
        const pages = [...this._lru.keys()].filter((index) => !this._pinnedPages.has(index)).reverse();

        let evictIndex = 0;

        const evictNext = () => {
            if (evictIndex >= pagesToEvict || evictIndex >= pages.length) {
                // Eviction complete
                return callback(null);
            }

            const pageIndex = pages[evictIndex++];
            const page = this._pages.get(pageIndex);

            if (flushBeforeEvict) {
                // Flush page before eviction
                this.flush(pageIndex * this.pageSize, this.pageSize, (err) => {
                    if (err) {
                        console.error(`Failed to flush page ${pageIndex} during eviction:`, err);
                    }
                    this._evictPage(pageIndex);
                    setImmediate(evictNext);
                });
            } else {
                this._evictPage(pageIndex);
                setImmediate(evictNext);
            }
        };

        evictNext();
    }







    /**
     * Pins a range of pages in the overlay.
     */
    pin(offset, size) {
        const startPage = Math.floor(offset / this.pageSize);
        const endPage = Math.floor((offset + size - 1) / this.pageSize);

        for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
            this._pinnedPages.add(pageIndex);
        }
    }

    /**
     * Unpins a range of pages in the overlay.
     */
    unpin(offset, size) {
        const startPage = Math.floor(offset / this.pageSize);
        const endPage = Math.floor((offset + size - 1) / this.pageSize);

        for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
            this._pinnedPages.delete(pageIndex);
        }
    }

    /**
     * Sets the bitmask for modification control.
     */
    setBitmask(bitmaskBuffer) {
        this._bitmask = bitmaskBuffer;
    }

    /**
     * Clears the bitmask.
     */
    clearBitmask() {
        this._bitmask = null;
    }

    /**
     * Checks if the bits at the specified offset and length are set in the bitmask.
     */
    _isBitSet(offset, length) {
        if (!this._bitmask) return true;

        for (let i = 0; i < length; i++) {
            const bitIndex = offset + i;
            const byteIndex = Math.floor(bitIndex / 8);
            const bitInByte = bitIndex % 8;

            if (byteIndex >= this._bitmask.length) {
                return false;
            }

            const byte = this._bitmask[byteIndex];
            if (((byte >> bitInByte) & 1) === 0) {
                return false;
            }
        }

        return true;
    }

    /**
     * Ensures that the storage is open.
     */
    _ensureOpen(callback) {
        if (this.opened) return callback(null);
        this.open((err) => {
            if (err) return callback(err);
            // Ensure underlying storage is open
            if (typeof this._underlying._ensureOpen === 'function') {
                this._underlying._ensureOpen(callback);
            } else {
                callback(null);
            }
        });
    }


    /**
     * Checks if the underlying storage supports a method.
     */
    _supports(methodName) {
        return typeof this._underlying[methodName] === 'function';
    }

    /**
     * Gets a page from the overlay or loads it from the underlying storage.
     */
    _getPage(pageIndex, callback) {
        let page = this._pages.get(pageIndex);
        if (page) return callback(null, page);

        this._loadPage(pageIndex, callback);
    }

    /**
     * Gets a page or creates a new one if it doesn't exist.
     */
    _getOrCreatePage(pageIndex, callback) {
        let page = this._pages.get(pageIndex);
        if (page) return callback(null, page);

        this._loadOrCreatePage(pageIndex, callback);
    }

    /**
     * Loads a page from the underlying storage.
     */
    _loadPage(pageIndex, callback) {
        const pageOffset = pageIndex * this.pageSize;
        const page = {
            data: b4a.alloc(this.pageSize, 0), // Zero-filled buffer
            modified: false,
        };

        if (this._fileExists && this._supports('read')) {
            const bytesToRead = Math.min(this.pageSize, this._size - pageOffset);
            if (bytesToRead > 0) {
                this._underlying.read(pageOffset, bytesToRead, (err, buf) => {
                    if (err) return callback(err);

                    page.data.set(buf.subarray(0, bytesToRead), 0);
                    this._pages.set(pageIndex, page);
                    this._lru.set(pageIndex, true);
                    callback(null, page);
                });
            } else {
                // No data to read
                this._pages.set(pageIndex, page);
                this._lru.set(pageIndex, true);
                callback(null, page);
            }
        } else {
            // Cannot read from underlying storage
            this._pages.set(pageIndex, page);
            this._lru.set(pageIndex, true);
            callback(null, page);
        }
    }

    /**
     * Loads a page from the underlying storage or creates a new one.
     */
    _loadOrCreatePage(pageIndex, callback) {
        this._loadPage(pageIndex, callback);
    }

    /**
     * Updates the access time for LRU eviction.
     */
    _touchPage(pageIndex) {
        this._accessTimes.set(pageIndex, Date.now());
        this._lru.get(pageIndex); // Update LRU ordering
    }

    /**
     * Handles eviction of a page from the overlay.
     */
    _onEvict(pageIndex, value) {
        const page = this._pages.get(pageIndex);
        if (!page) return;

        // If the page is pinned, don't evict it
        if (this._pinnedPages.has(pageIndex)) {
            return false;
        }

        if (page.modified && this._autoFlushOnEvict) {
            // Flush page before eviction if it was modified and autoFlushOnEvict is set
            this.flush(pageIndex * this.pageSize, this.pageSize, (err) => {
                if (err) {
                    console.error(`Failed to flush page ${pageIndex} during eviction:`, err);
                }
                this._evictPage(pageIndex);
            });
        } else {
            this._evictPage(pageIndex);
        }
    }



    /**
     * Evicts a single page from the overlay.
     */
    _evictPage(pageIndex) {
        // Skip eviction if the page is pinned
        if (this._pinnedPages.has(pageIndex)) {
            return; // Do nothing if the page is pinned
        }

        this._pages.delete(pageIndex);
        this._lru.delete(pageIndex);
        this._modifiedPages.delete(pageIndex);
        this._accessTimes.delete(pageIndex);
    }
}

export default RandomAccessLayeredStorage;
