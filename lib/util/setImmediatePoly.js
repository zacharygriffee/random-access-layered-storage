// setImmediate polyfill
(function (global) {
    if (typeof global.setImmediate !== 'function') {
        global.setImmediate = function (fn) {
            if (typeof Promise === 'function') {
                Promise.resolve().then(fn);
            } else {
                setTimeout(fn, 0);
            }
        };
    }
})(typeof self === 'undefined' ? typeof global === 'undefined' ? this : global : self);
