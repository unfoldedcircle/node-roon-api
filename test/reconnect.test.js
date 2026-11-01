/*
 * Regression tests for recovery after suspend and temporary network failures.
 * Copyright (c) 2026 Unfolded Circle ApS. Licensed under Apache-2.0.
 */
"use strict";

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Load the real library code with fake network transports; no Roon server or
// network access is required. Timers use the node:test virtual clock.
function loadModule(filename, overrides) {
    const file = path.resolve(__dirname, '..', filename);
    const localRequire = createRequire(file);
    const module = { exports: {} };
    const context = {
        module,
        exports: module.exports,
        require: name => name in overrides ? overrides[name] : localRequire(name),
        Buffer,
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout
    };
    context.global = context;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return module.exports;
}

function createWebSockets() {
    const sockets = [];
    class WebSocket extends EventEmitter {
        constructor() {
            super();
            sockets.push(this);
        }
        close() {}
        send() {}
        ping() {}
    }
    return { sockets, WebSocket };
}

test('discovery retries the same core after a connection fails before open', t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { sockets, WebSocket } = createWebSockets();
    const Transport = loadModule('transport-websocket.js', { ws: WebSocket });
    const sood = new EventEmitter();
    sood.start = cb => cb();
    sood.stop = () => {};
    sood.query = () => {};
    const RoonApi = loadModule('lib.js', {
        './transport-websocket.js': Transport,
        './sood.js': () => sood
    });
    let errors = 0;
    const roon = new RoonApi({
        extension_id: 'test.reconnect',
        display_name: 'Reconnect test',
        display_version: '1',
        publisher: 'Unfolded Circle',
        email: 'support@unfoldedcircle.com',
        moo_onerror: () => errors++
    });
    t.after(() => roon.stop_discovery());
    roon.start_discovery();
    const response = {
        from: { ip: '192.0.2.1' },
        props: {
            service_id: '00720724-5143-4a9b-abac-0e50cba674bb',
            unique_id: 'core-1',
            http_port: 9330
        }
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
        sood.emit('message', response);
        assert.equal(sockets.length, attempt, 'failed connections must not suppress rediscovery');
        const socket = sockets[attempt - 1];
        socket.onerror(Object.assign(new Error('Network unreachable'), { code: 'ENETUNREACH' }));
        socket.onclose();
    }
    assert.equal(errors, 3);

    // Once the network returns, discovery can connect and start registration.
    sood.emit('message', response);
    assert.equal(sockets.length, 4);
    let requests = 0;
    sockets[3].send = () => requests++;
    sockets[3].onopen();
    assert.equal(requests, 1);
    sood.emit('message', response);
    assert.equal(sockets.length, 4, 'a live connection must still suppress duplicates');
    sockets[3].onclose();
});

for (const opened of [false, true]) {
    test(`transport close notifies and cleans up once (opened=${opened})`, t => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
        const { sockets, WebSocket } = createWebSockets();
        const Transport = loadModule('transport-websocket.js', { ws: WebSocket });
        const transport = new Transport('192.0.2.1', 9330);
        let closes = 0;
        let cleanups = 0;
        transport.onclose = () => closes++;
        transport.moo = { clean_up: () => cleanups++ };
        if (opened) sockets[0].onopen();

        transport.close();
        sockets[0].onclose();
        transport.close();
        assert.equal(closes, 1);
        assert.equal(cleanups, 1);
    });
}

test('discovery resumes interface polling and recreates failed sockets after standby', t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let interfaces = {};
    let polls = 0;
    class Socket extends EventEmitter {
        bind(options, callback) { callback(); }
        setBroadcast() {}
        setMulticastTTL() {}
        addMembership() {}
        close() { this.emit('close'); }
    }
    const createSood = loadModule('sood.js', {
        os: { networkInterfaces: () => { polls++; return interfaces; } },
        dgram: { createSocket: () => new Socket() }
    });
    const sood = createSood();
    t.after(() => sood.stop());
    sood.start();
    sood.stop();
    sood.stop();
    sood.start();
    assert.equal(polls, 2);

    // Wi-Fi only obtains its IPv4 address after wake discovery has started.
    interfaces = { wlan0: [{ family: 'IPv4', address: '192.0.2.2', netmask: '255.255.255.0' }] };
    t.mock.timers.tick(5000);
    assert.equal(polls, 3, 'network interface polling must restart after stop');
    assert.ok(sood._multicast['192.0.2.2'].send_sock);

    // Socket errors during network recovery are retried by the next poll.
    const previousSocket = sood._multicast['192.0.2.2'].send_sock;
    previousSocket.emit('error', new Error('Network unreachable'));
    t.mock.timers.tick(5000);
    assert.ok(sood._multicast['192.0.2.2'].send_sock);
    assert.notEqual(sood._multicast['192.0.2.2'].send_sock, previousSocket);

    sood.start();
    const beforePoll = polls;
    t.mock.timers.tick(5000);
    assert.equal(polls, beforePoll + 1, 'repeated starts must not duplicate polling');
    sood.stop();
    const beforeStop = polls;
    t.mock.timers.tick(10000);
    assert.equal(polls, beforeStop, 'polling must remain stopped during standby');
    sood.start();
    const beforeResume = polls;
    t.mock.timers.tick(5000);
    assert.equal(polls, beforeResume + 1, 'subsequent wake cycles must also resume polling');
});
