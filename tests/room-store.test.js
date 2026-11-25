const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createRoomStore, normalizeComment, OWNER_ID, MAX_VIEWERS, MAX_COMMENT_LENGTH, COMMENT_RATE_LIMIT
} = require('../src/network/room-store');

function room(now) {
    const store = createRoomStore(now ? { now } : {});
    store.create({ code: 'ABCDEFGHJKLM', title: 'Lecture', networkMode: 'global', token: 'TOKENTOKEN22', ownerName: 'Host A' });
    return store;
}

test('viewers join with the code and the link token only', () => {
    const store = room();
    assert.equal(store.join({ code: 'ZZZZZZZZZZZZ', token: 'TOKENTOKEN22', socketId: 'a' }).error, 'bad-code');
    assert.equal(store.join({ code: 'ABCDEFGHJKLM', token: 'WRONG', socketId: 'a' }).error, 'bad-token');
    assert.equal(store.join({ code: 'ABCDEFGHJKLM', socketId: 'a' }).error, 'bad-token');
    const ok = store.join({ code: 'abcdefghjklm', token: 'TOKENTOKEN22', name: 'Sara', socketId: 'a' });
    assert.equal(ok.ok, true);
    assert.equal(ok.viewer.id, 'v001');
    assert.deepEqual(store.participants().map((p) => p.name), ['Host A', 'Sara']);
    assert.equal(store.participants()[0].isOwner, true);
});

test('the room has a viewer limit', () => {
    const store = room();
    for (let i = 0; i < MAX_VIEWERS; i++) {
        assert.equal(store.join({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', socketId: `s${i}` }).ok, true);
    }
    assert.equal(store.join({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', socketId: 'late' }).error, 'room-full');
});

test('comments: cleaned, bounded, named, and rate limited per sender', () => {
    let clock = 0;
    const store = room(() => clock);
    const { viewer } = store.join({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', name: 'Sara', socketId: 'a' });
    assert.equal(store.addComment(viewer.id, '   ').error, 'empty-comment');
    assert.equal(store.addComment('v999', 'hi').error, 'not-in-room');

    const first = store.addComment(viewer.id, 'hello\u0000 world');
    assert.equal(first.ok, true);
    assert.equal(first.comment.text, 'hello  world');
    assert.equal(first.comment.name, 'Sara');
    assert.equal(first.comment.isOwner, false);

    for (let i = 1; i < COMMENT_RATE_LIMIT; i++) assert.equal(store.addComment(viewer.id, `c${i}`).ok, true);
    assert.equal(store.addComment(viewer.id, 'too many').error, 'comment-rate');
    assert.equal(store.addComment(OWNER_ID, 'the owner has its own budget').comment.isOwner, true);
    clock += 10000;
    assert.equal(store.addComment(viewer.id, 'later').ok, true);

    assert.equal(normalizeComment('x'.repeat(2000)).length, MAX_COMMENT_LENGTH);
    assert.equal(normalizeComment('line 1\nline 2'), 'line 1\nline 2', 'line breaks are kept');
});

test('microphone state shows in the participant list', () => {
    const store = room();
    const { viewer } = store.join({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', name: 'Sara', socketId: 'a' });
    assert.equal(store.setMic(viewer.id, true), true);
    assert.equal(store.setMic(OWNER_ID, true), true);
    assert.deepEqual(store.participants().map((p) => p.micOn), [true, true]);
    assert.equal(store.setMic('v404', true), false);
});

test('leaving, removal and expiry', () => {
    let clock = 0;
    const store = createRoomStore({ now: () => clock });
    store.create({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', durationMinutes: 60 });
    const a = store.join({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', socketId: 'a' }).viewer;
    const b = store.join({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', socketId: 'b' }).viewer;
    assert.equal(store.leaveBySocket('a').id, a.id);
    assert.equal(store.remove(b.id).id, b.id);
    assert.equal(store.viewers().length, 0);
    clock += 60 * 60 * 1000;
    assert.equal(store.join({ code: 'ABCDEFGHJKLM', token: 'TOKENTOKEN22', socketId: 'c' }).error, 'no-room');
});
