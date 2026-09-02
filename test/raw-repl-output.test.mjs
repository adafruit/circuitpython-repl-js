import assert from "node:assert/strict";
import test from "node:test";

import {REPL} from "../repl.js";

const MODE_NORMAL = 1;
const MODE_RAW = 2;

function replWaitingForRawResponse() {
    const repl = new REPL();
    repl._mode = MODE_RAW;
    repl._pythonCodeRunning = true;

    repl._serialInputBuffer.append("\r\nraw REPL; CTRL-B to exit\r\n>");
    repl._serialInputBuffer.readUntil(/raw REPL; CTRL-B to exit/);
    repl._serialInputBuffer.readUntil(">");

    return repl;
}

async function receiveRawResponse(repl, chunks) {
    for (const chunk of chunks) {
        repl._serialInputBuffer.append(chunk);
        await repl._checkCodeRunning();
    }
}

test("raw output containing a friendly prompt is treated as output", async () => {
    const repl = replWaitingForRawResponse();

    await receiveRawResponse(repl, [
        "OKbefore >>> after\r\n\x04\x04>",
    ]);

    assert.equal(repl._mode, MODE_RAW);
    assert.equal(repl._pythonCodeRunning, false);
    assert.equal(repl.getCodeOutput(), "before >>> after\r\n");
});

test("a complete friendly prompt line in raw output is treated as output", async () => {
    const repl = replWaitingForRawResponse();

    await receiveRawResponse(repl, [
        "OKbefore\r\n>>> \r\nafter\r\n\x04\x04>",
    ]);

    assert.equal(repl._mode, MODE_RAW);
    assert.equal(repl._pythonCodeRunning, false);
    assert.equal(repl.getCodeOutput(), "before\r\n>>> \r\nafter\r\n");
});

test("prompt-like startup text in raw output does not trigger mode detection", async () => {
    const repl = replWaitingForRawResponse();

    await receiveRawResponse(repl, [
        "OKPress any key to enter the REPL.\r\n\x04\x04>",
    ]);

    assert.equal(repl._mode, MODE_RAW);
    assert.equal(repl._pythonCodeRunning, false);
    assert.equal(repl.getCodeOutput(), "Press any key to enter the REPL.\r\n");
});

test("raw response acknowledgement may be split across serial chunks", async () => {
    const repl = replWaitingForRawResponse();

    await receiveRawResponse(repl, ["O"]);
    assert.equal(repl._pythonCodeRunning, true);
    assert.equal(repl._serialInputBuffer.getRemainingByteCount(), 1);

    await receiveRawResponse(repl, ["Koutput\r\n", "\x04", "\x04", ">"]);

    assert.equal(repl._mode, MODE_RAW);
    assert.equal(repl._pythonCodeRunning, false);
    assert.equal(repl.getCodeOutput(), "output\r\n");
});

test("normal-mode prompt detection is unchanged", async () => {
    const repl = new REPL();
    repl._mode = MODE_NORMAL;
    repl._pythonCodeRunning = true;
    repl._serialInputBuffer.append(">>> ");

    await repl._checkCodeRunning();

    assert.equal(repl._mode, MODE_NORMAL);
    assert.equal(repl._pythonCodeRunning, false);
});
