import assert from "node:assert/strict";
import test from "node:test";

import {REPL} from "../repl.js";

const TITLE_START = "\x1b]0;";
const TITLE_END = "\x1b\\";

class TestREPL extends REPL {
    constructor() {
        super();
        this.terminalData = "";
    }

    writeToTerminal(data) {
        this.terminalData += data;
    }
}

const receive = async (repl, data) => repl.onSerialReceive({data});

test("title delimiters may be split across serial chunks", async () => {
    const repl = new TestREPL();

    await receive(repl, "before\x1b");
    await receive(repl, "]0");
    await receive(repl, ";🐍 Wi-Fi: off | Done | 10.0.1\x1b");
    await receive(repl, "\\after");

    assert.equal(repl.title, "🐍 Wi-Fi: off | Done | 10.0.1");
    assert.equal(
        repl.terminalData,
        `before${TITLE_START}🐍 Wi-Fi: off | Done | 10.0.1${TITLE_END}after`,
    );
});

test("a new title sequence replaces the previous title", async () => {
    const repl = new TestREPL();

    await receive(repl, `${TITLE_START}🐍 old${TITLE_END}`);
    await receive(repl, `${TITLE_START}🐍 new${TITLE_END}`);

    assert.equal(repl.title, "🐍 new");
});

test("output before a partial delimiter is processed immediately", async () => {
    const repl = new TestREPL();

    await receive(repl, "complete output\x1b]");

    assert.equal(repl.terminalData, "complete output");
    assert.equal(repl._serialInputBuffer.get(), "complete output");
    assert.equal(repl._partialToken, "\x1b]");

    await receive(repl, "0;🐍 title\x1b\\");

    assert.equal(repl.title, "🐍 title");
});

test("an incomplete delimiter is flushed after the partial-token timeout", async () => {
    const repl = new TestREPL();

    await receive(repl, "output\x1b]");
    assert.equal(repl.terminalData, "output");

    await new Promise(resolve => setTimeout(resolve, 300));

    assert.equal(repl.terminalData, "output\x1b]");
    assert.equal(repl._serialInputBuffer.get(), "output\x1b]");
    assert.equal(repl._partialToken, "");
});

test("ordinary escape sequences are not buffered", async () => {
    const repl = new TestREPL();

    await receive(repl, "color: \x1b[91mred\x1b[0m");

    assert.equal(repl.terminalData, "color: \x1b[91mred\x1b[0m");
    assert.equal(repl._partialToken, "");
});
