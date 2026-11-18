const assert = require('node:assert/strict');
const { test } = require('node:test');
const { io: createClient } = require('socket.io-client');
const { createLocalHostNode } = require('../server');
const { isAllowedControlKey, pressControlKey } = require('../keyboard-controls');

test('only allowlisted key names reach the native keyboard adapter', () => {
    const nativeKeyboard = require('@nut-tree-fork/libnut-win32');
    const originalKeyTap = nativeKeyboard.keyTap;
    const pressedKeys = [];
    nativeKeyboard.keyTap = (key) => pressedKeys.push(key);

    try {
        pressControlKey('ArrowUp');
        pressControlKey('Enter');
        assert.throws(() => pressControlKey('Control'), /Unsupported remote control key/);
        assert.deepEqual(pressedKeys, ['up', 'enter']);
    } finally {
        nativeKeyboard.keyTap = originalKeyTap;
    }
});

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = createClient(`http://127.0.0.1:${port}`);
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out connecting to the local control server.'));
        }, 3000);
        socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once('connect_error', (error) => {
            clearTimeout(timer);
            socket.close();
            reject(error);
        });
    });
}

function emitAck(socket, event, payload) {
    return new Promise((resolve, reject) => {
        socket.timeout(3000).emit(event, payload, (error, response) => {
            if (error) reject(error);
            else resolve(response);
        });
    });
}

function waitForEvent(socket, event, predicate) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, onEvent);
            reject(new Error(`Timed out waiting for ${event}.`));
        }, 3000);
        const onEvent = (payload) => {
            if (!predicate(payload)) return;
            clearTimeout(timer);
            socket.off(event, onEvent);
            resolve(payload);
        };
        socket.on(event, onEvent);
    });
}

test('multiple students receive unique IDs and only the selected consenting student gets control', {
    timeout: 20000
}, async (t) => {
    assert.equal(isAllowedControlKey('ArrowUp'), true);
    assert.equal(isAllowedControlKey('Enter'), true);
    assert.equal(isAllowedControlKey('Meta'), false);
    assert.equal(isAllowedControlKey('type arbitrary text'), false);

    const hostNode = createLocalHostNode();
    const { port } = await hostNode.start();
    const host = await connect(port);
    const firstStudent = await connect(port);
    const secondStudent = await connect(port);
    const otherClient = await connect(port);
    t.after(async () => {
        host.disconnect();
        firstStudent.disconnect();
        secondStudent.disconnect();
        otherClient.disconnect();
        await hostNode.stop();
    });

    host.emit('register-host-ui');
    const session = await emitAck(host, 'host-create-code', { durationMinutes: 0 });
    assert.equal(session.ok, true);

    const firstJoin = await emitAck(firstStudent, 'sender-join-code', { code: session.session.code });
    const secondJoin = await emitAck(secondStudent, 'sender-join-code', { code: session.session.code });
    assert.equal(firstJoin.ok, true);
    assert.equal(secondJoin.ok, true);
    assert.notEqual(firstJoin.studentId, secondJoin.studentId);

    const bothStudentsSharing = waitForEvent(
        host,
        'host-session-state',
        (state) => state && state.students.length === 2 && state.students.every((student) => student.isSharing)
    );
    firstStudent.emit('sender-start-sharing');
    secondStudent.emit('sender-start-sharing');
    await bothStudentsSharing;

    const deniedBeforeConsent = await emitAck(host, 'host-control-key', {
        studentId: firstJoin.studentId,
        key: 'ArrowUp'
    });
    assert.equal(deniedBeforeConsent.ok, false);

    const permissionChanged = waitForEvent(
        host,
        'control-permission-changed',
        (state) => state && state.studentId === firstJoin.studentId && state.enabled
    );
    const permission = await emitAck(firstStudent, 'sender-control-permission', { enabled: true });
    assert.equal(permission.ok, true);
    await permissionChanged;

    await emitAck(secondStudent, 'sender-control-permission', { enabled: true });

    const firstViewStarted = waitForEvent(
        firstStudent,
        'student-start-viewing',
        (payload) => payload.studentId === firstJoin.studentId
    );
    const firstSelected = await emitAck(host, 'host-select-student', { studentId: firstJoin.studentId });
    assert.equal(firstSelected.ok, true);
    await firstViewStarted;

    const hostReceivedOffer = waitForEvent(
        host,
        'webrtc-offer',
        (payload) => payload.studentId === firstJoin.studentId
    );
    firstStudent.emit('webrtc-offer', {
        studentId: firstJoin.studentId,
        offer: { type: 'offer', sdp: 'first-student-offer' }
    });
    const firstOffer = await hostReceivedOffer;
    assert.equal(firstOffer.offer.sdp, 'first-student-offer');

    const firstReceivedAnswer = waitForEvent(
        firstStudent,
        'webrtc-answer',
        (payload) => payload.studentId === firstJoin.studentId
    );
    host.emit('webrtc-answer', {
        studentId: firstJoin.studentId,
        answer: { type: 'answer', sdp: 'first-student-answer' }
    });
    assert.equal((await firstReceivedAnswer).answer.sdp, 'first-student-answer');

    const firstReceivedCandidate = waitForEvent(
        firstStudent,
        'webrtc-ice-candidate',
        (payload) => payload.studentId === firstJoin.studentId
    );
    host.emit('webrtc-ice-candidate', {
        studentId: firstJoin.studentId,
        target: 'sender',
        candidate: { candidate: 'first-student-candidate' }
    });
    assert.equal((await firstReceivedCandidate).candidate.candidate, 'first-student-candidate');

    const receivedKey = waitForEvent(
        firstStudent,
        'student-control-key',
        (payload) => payload.key === 'ArrowLeft'
    );
    const sentKey = await emitAck(host, 'host-control-key', {
        studentId: firstJoin.studentId,
        key: 'ArrowLeft'
    });
    assert.equal(sentKey.ok, true);
    assert.deepEqual(await receivedKey, { studentId: firstJoin.studentId, key: 'ArrowLeft' });

    const unselectedStudentKey = await emitAck(host, 'host-control-key', {
        studentId: secondJoin.studentId,
        key: 'Enter'
    });
    assert.equal(unselectedStudentKey.ok, false);

    const secondViewStopped = waitForEvent(
        firstStudent,
        'student-stop-viewing',
        (payload) => payload.studentId === firstJoin.studentId
    );
    const secondViewStarted = waitForEvent(
        secondStudent,
        'student-start-viewing',
        (payload) => payload.studentId === secondJoin.studentId
    );
    const secondSelected = await emitAck(host, 'host-select-student', { studentId: secondJoin.studentId });
    assert.equal(secondSelected.ok, true);
    await Promise.all([secondViewStopped, secondViewStarted]);

    const secondReceivedKey = waitForEvent(
        secondStudent,
        'student-control-key',
        (payload) => payload.key === 'Enter'
    );
    const sentToSecond = await emitAck(host, 'host-control-key', {
        studentId: secondJoin.studentId,
        key: 'Enter'
    });
    assert.equal(sentToSecond.ok, true);
    await secondReceivedKey;

    const disallowedKey = await emitAck(host, 'host-control-key', {
        studentId: secondJoin.studentId,
        key: 'Meta'
    });
    assert.equal(disallowedKey.ok, false);

    const otherClientKey = await emitAck(otherClient, 'host-control-key', {
        studentId: secondJoin.studentId,
        key: 'Enter'
    });
    assert.equal(otherClientKey.ok, false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const burst = await Promise.all(
        Array.from({ length: 13 }, () => emitAck(host, 'host-control-key', {
            studentId: secondJoin.studentId,
            key: 'Enter'
        }))
    );
    assert.equal(burst.filter((response) => response.ok).length, 12);

    const pausedState = waitForEvent(
        host,
        'host-session-state',
        (state) => state &&
            state.students.some((student) => student.id === secondJoin.studentId && student.isPaused && !student.controlEnabled)
    );
    secondStudent.emit('sender-pause-sharing');
    await pausedState;
    const deniedWhilePaused = await emitAck(host, 'host-control-key', {
        studentId: secondJoin.studentId,
        key: 'Enter'
    });
    assert.equal(deniedWhilePaused.ok, false);

    const resumedState = waitForEvent(
        host,
        'host-session-state',
        (state) => state &&
            state.students.some((student) => student.id === secondJoin.studentId && student.isSharing && !student.isPaused)
    );
    secondStudent.emit('sender-resume-sharing');
    await resumedState;
    const deniedAfterResume = await emitAck(host, 'host-control-key', {
        studentId: secondJoin.studentId,
        key: 'Enter'
    });
    assert.equal(deniedAfterResume.ok, false);

    const permissionRevoked = await emitAck(secondStudent, 'sender-control-permission', { enabled: false });
    assert.equal(permissionRevoked.ok, true);
    const deniedAfterRevocation = await emitAck(host, 'host-control-key', {
        studentId: secondJoin.studentId,
        key: 'Enter'
    });
    assert.equal(deniedAfterRevocation.ok, false);

    const rosterAfterStop = waitForEvent(
        host,
        'host-session-state',
        (state) => state &&
            state.students.some((student) => student.id === secondJoin.studentId && !student.isSharing)
    );
    secondStudent.emit('sender-stop-sharing');
    await rosterAfterStop;
});
