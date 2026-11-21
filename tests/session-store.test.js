const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore, CONTROL_RATE_LIMIT } = require('../src/session-store');

function sharingStudent(store, socketId, title) {
    const { student } = store.join({ code: store.session.code, title, socketId });
    store.markSharing(student.id, true);
    return student;
}

test('students get sequential three-digit numbers and keep their own titles', () => {
    const store = createSessionStore();
    store.create({ code: 'ABCDEFGHJKLM', durationMinutes: 60 });
    const a = store.join({ code: 'abcdefghjklm', title: 'Ahmed Ali - Graduation Project', socketId: 's1' });
    const b = store.join({ code: 'ABCDEFGHJKLM', title: '', socketId: 's2' });
    assert.equal(a.student.id, '001');
    assert.equal(b.student.id, '002');
    assert.equal(a.student.title, 'Ahmed Ali - Graduation Project');
    assert.equal(b.student.title, 'الطالب 002');
});

test('joining with a wrong code or without a session is refused', () => {
    const store = createSessionStore();
    assert.equal(store.join({ code: 'X', socketId: 's' }).reason, 'no-session');
    store.create({ code: 'ABCDEFGHJKLM' });
    assert.equal(store.join({ code: 'ZZZZZZZZZZZZ', socketId: 's' }).reason, 'bad-code');
});

test('the same socket joining twice keeps one student entry', () => {
    const store = createSessionStore();
    store.create({ code: 'ABCDEFGHJKLM' });
    const first = store.join({ code: 'ABCDEFGHJKLM', socketId: 's1' });
    const again = store.join({ code: 'ABCDEFGHJKLM', socketId: 's1' });
    assert.equal(first.student, again.student);
    assert.equal(store.serialize().students.length, 1);
});

test('a session expires after its duration', () => {
    let clock = 1_000_000;
    const store = createSessionStore({ now: () => clock });
    store.create({ code: 'ABCDEFGHJKLM', durationMinutes: 20 });
    assert.equal(store.isExpired(), false);
    clock += 20 * 60 * 1000;
    assert.equal(store.isExpired(), true);
    assert.equal(store.join({ code: 'ABCDEFGHJKLM', socketId: 's' }).reason, 'no-session');
});

test('keys reach only the selected, sharing, unpaused student who allowed control', () => {
    const store = createSessionStore();
    store.create({ code: 'ABCDEFGHJKLM' });
    const a = sharingStudent(store, 's1', 'A');
    const b = sharingStudent(store, 's2', 'B');

    assert.equal(store.canSendKey(a.id), false, 'not selected and no permission');
    store.select(a.id);
    assert.equal(store.canSendKey(a.id), false, 'selected but no permission');
    assert.equal(store.setControl(a.id, true), true);
    assert.equal(store.canSendKey(a.id), true);

    store.setControl(b.id, true);
    assert.equal(store.canSendKey(b.id), false, 'permission but not selected');

    store.markPaused(a.id, true);
    assert.equal(store.canSendKey(a.id), false, 'paused');
    assert.equal(store.get(a.id).controlEnabled, false, 'pausing revokes permission');
});

test('control cannot be enabled before sharing starts', () => {
    const store = createSessionStore();
    store.create({ code: 'ABCDEFGHJKLM' });
    const { student } = store.join({ code: 'ABCDEFGHJKLM', socketId: 's1' });
    assert.equal(store.setControl(student.id, true), false);
    assert.equal(store.select(student.id).ok, false);
});

test(`at most ${CONTROL_RATE_LIMIT} keys per second are accepted`, () => {
    let clock = 0;
    const store = createSessionStore({ now: () => clock });
    store.create({ code: 'ABCDEFGHJKLM' });
    const a = sharingStudent(store, 's1', 'A');
    store.select(a.id);
    store.setControl(a.id, true);
    let accepted = 0;
    for (let i = 0; i < CONTROL_RATE_LIMIT + 5; i++) if (store.canSendKey(a.id)) accepted++;
    assert.equal(accepted, CONTROL_RATE_LIMIT);
    clock += 1000;
    assert.equal(store.canSendKey(a.id), true, 'a new second opens a new window');
});

test('stopping or leaving clears the selection and the permission', () => {
    const store = createSessionStore();
    store.create({ code: 'ABCDEFGHJKLM' });
    const a = sharingStudent(store, 's1', 'A');
    store.select(a.id);
    store.setControl(a.id, true);
    store.markSharing(a.id, false);
    assert.equal(store.serialize().selectedStudentId, null);
    assert.equal(store.get(a.id).controlEnabled, false);

    store.markSharing(a.id, true);
    store.select(a.id);
    assert.equal(store.removeBySocket('s1').id, a.id);
    assert.equal(store.serialize().selectedStudentId, null);
    assert.equal(store.get(a.id), null);
});
