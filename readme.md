# RandomAccessLayeredStorage

`RandomAccessLayeredStorage` is an extension of the `random-access-storage` interface that provides a memory overlay over any underlying random-access-storage implementation. It supports in-memory caching, layered storage systems, and eviction of memory pages to underlying storage.

## Installation

To use this class in your project, ensure you have the following dependencies installed:

```bash
npm install random-access-layered-storage
```

Then, import `RandomAccessLayeredStorage` into your project:

```js
import RandomAccessLayeredStorage from 'random-access-layered-storage';
```


## Features

- **Memory Overlay**: Cache data in memory for faster access.
- **Layered Storage**: Chain multiple layers of storage (e.g., memory over disk).
- **LRU Cache**: Uses an LRU (Least Recently Used) eviction policy to manage memory usage.
- **Automatic Flushing**: Flush changes to the underlying storage automatically or on-demand.
- **Bitmask Modification Control**: Control which parts of the file are writable.
- **Supports Growing and Shrinking**: The file size can grow and shrink dynamically.
- **Multiple Public API Methods**: Provides methods for reading, writing, deleting, truncating, flushing, and more.


---

### Interface Compliance

This library aims to provide a flexible, layered storage solution, building upon the `random-access-storage` (RAS) interface. Currently, **RandomAccessLayeredStorage** offers a range of functionality similar to the RAS interface, but with some deviations. These deviations are primarily due to the fact that this version of the library is still evolving towards full compliance with the RAS interface.

#### Current State:
- The library supports most core operations such as `write`, `read`, `delete`, `truncate`, and `flush`.
- Eviction policies and in-memory overlays are additional features not standard in RAS but included for enhanced flexibility.
- Some edge cases, particularly related to strict size enforcement and layered eviction, may behave differently than expected from a traditional RAS-compliant implementation.
- **Important Note**: While most features work in line with the expectations of the RAS interface, it is not yet fully compliant with all RAS specifications, especially in edge cases regarding eviction and flushing.

#### Future Versions:
Future versions of **RandomAccessLayeredStorage** will work towards full RAS interface compliance. These enhancements will include:
- Complete alignment with the `random-access-storage` interface methods and behaviors.
- A more robust handling of eviction, flushing, and edge cases.
- Improved handling of strict size limits and better control over page eviction policies, including optional compliance flags.

#### Usage and Expectations:
If you are using this library in environments where strict `random-access-storage` compliance is necessary, it is recommended to:
- Test thoroughly against the specific behavior you require.
- Understand that subsequent versions will introduce breaking changes to achieve full interface compliance.

By providing an interface that is mostly aligned with RAS, this library offers many of the benefits of the standard RAS system while also introducing additional flexibility in how data is managed in layered storage. Over time, as we achieve full compliance, you will be able to use this library in scenarios requiring strict adherence to the RAS specification.

## Public Methods

### `open(callback)`

Opens the storage. This is required before any other operations are performed.

- **callback**: `function (error)` - Called when the storage is opened or if an error occurs.

### `read(offset, size, callback)`

Reads data from the specified offset and size.

- **offset**: The byte offset to start reading from.
- **size**: The number of bytes to read.
- **callback**: `function (error, buffer)` - Called with the read data or an error.

### `write(offset, buffer, callback)`

Writes data to the specified offset.

- **offset**: The byte offset to write to.
- **buffer**: The `Buffer` containing data to write.
- **callback**: `function (error)` - Called when the write completes or if an error occurs.

### `del(offset, size, callback)`

Deletes data starting at the given offset for a specified size. Internally fills the space with zeroes.

- **offset**: The byte offset where deletion starts.
- **size**: The number of bytes to delete.
- **callback**: `function (error)` - Called when the deletion is complete or if an error occurs.

### `truncate(offset, callback)`

Truncates the file at the specified offset. It can grow or shrink the file.

- **offset**: The byte offset to truncate to.
- **callback**: `function (error)` - Called when truncation is complete or if an error occurs.

### `flush(offset = 0, size = this.size, callback)`

Flushes modified pages in memory to the underlying storage. Optionally specify a byte range to flush.

- **offset**: The byte offset to start flushing from (default: 0).
- **size**: The number of bytes to flush (default: total file size).
- **callback**: `function (error)` - Called when flushing is complete or if an error occurs.

### `stat(callback)`

Retrieves the current size of the storage.

- **callback**: `function (error, stats)` - Called with the size or if an error occurs.

### `close(callback)`

Closes the storage. Optionally flushes all modified data before closing if `flushOnClose` is enabled.

- **callback**: `function (error)` - Called when the storage is closed or if an error occurs.

### `unlink(callback)`

Unlinks (removes) the storage, clearing the memory cache and optionally removing the underlying storage.

- **callback**: `function (error)` - Called when the storage is unlinked or if an error occurs.

### `evict(percent = 1, flushBeforeEvict = false, callback = () => {})`

Evicts a percentage of the least recently used pages from memory. If `flushBeforeEvict` is `true`, modified pages will be flushed before eviction.

- **percent**: The percentage of pages to evict (default: 100%).
- **flushBeforeEvict**: Whether to flush modified pages before eviction (default: `false`).
- **callback**: `function (error)` - Called when eviction is complete or if an error occurs.

### `pin(offset, size)`

Pins a range of pages in memory, preventing them from being evicted.

- **offset**: The byte offset where the pin starts.
- **size**: The number of bytes to pin.

### `unpin(offset, size)`

Unpins a range of pages, allowing them to be evicted if necessary.

- **offset**: The byte offset where the unpin starts.
- **size**: The number of bytes to unpin.

### `setBitmask(bitmaskBuffer)`

Sets a bitmask for controlling write access to parts of the storage.

- **bitmaskBuffer**: A buffer containing the bitmask.

### `clearBitmask()`

Clears the bitmask, allowing writes to all parts of the storage.

### `length`

Returns the current size of the storage.

### `size`

Alias for `length`. Returns the current size of the storage.

## Usage Example

```js
import RandomAccessLayeredStorage from 'random-access-layered-storage';
import RAM from 'random-access-memory';

// Create a layered storage with an underlying RAM store
const underlyingStorage = new RAM();
const storage = new RandomAccessLayeredStorage(underlyingStorage, { pageSize: 1024, maxPages: 10 });

storage.open((err) => {
    if (err) throw err;

    // Write some data
    const data = Buffer.from('Hello, world!');
    storage.write(0, data, (err) => {
        if (err) throw err;

        // Read the data back
        storage.read(0, data.length, (err, readData) => {
            if (err) throw err;
            console.log(readData.toString()); // Outputs: 'Hello, world!'
        });
    });
});
```

## License

This project is licensed under the MIT License.
