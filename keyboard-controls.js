const CONTROL_KEYS = Object.freeze({
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Enter: 'enter',
    Space: 'space',
    Escape: 'escape',
    Tab: 'tab',
    PageUp: 'pageup',
    PageDown: 'pagedown',
    Home: 'home',
    End: 'end'
});

function isAllowedControlKey(key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(CONTROL_KEYS, key);
}

function pressControlKey(key) {
    if (!isAllowedControlKey(key)) {
        throw new Error('Unsupported remote control key.');
    }

    const { keyTap } = require('@nut-tree-fork/libnut-win32');
    keyTap(CONTROL_KEYS[key]);
}

module.exports = { CONTROL_KEYS, isAllowedControlKey, pressControlKey };
