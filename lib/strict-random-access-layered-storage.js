import RandomAccessLayeredStorage from "./random-access-layered-storage.js";

export class StrictRandomAccessLayeredStorage extends RandomAccessLayeredStorage {
    constructor(underlyingStorage, opts = {}) {
        super(underlyingStorage, opts);
    }

    // Override the _read method to throw an error when reading beyond storage
    _read(req) {
        this._ensureOpen((err) => {
            if (err) return req.callback(err);

            // Check if the read request exceeds the current size of the storage
            if (req.offset + req.size > this._size) {
                return req.callback(new Error('Attempted to read beyond the storage size.'));
            }

            // Proceed with normal read operation
            super._read(req);
        });
    }
}

export default StrictRandomAccessLayeredStorage;