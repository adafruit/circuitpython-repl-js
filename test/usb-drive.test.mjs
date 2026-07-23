import assert from "node:assert/strict";
import test from "node:test";

import {REPL} from "../repl.js";

test("tryDisableUsbDrive returns true when CircuitPython disables the drive", async () => {
    const repl = new REPL();
    repl.runCode = async (code) => {
        assert.match(code, /unsafe_disable_usb_drive/);
        return "USB_DRIVE_DISABLED True\n";
    };

    assert.equal(await repl.tryDisableUsbDrive(), true);
});

test("tryDisableUsbDrive returns false when the feature is unavailable", async () => {
    const repl = new REPL();
    repl.runCode = async () => "USB_DRIVE_DISABLED False\n";

    assert.equal(await repl.tryDisableUsbDrive(), false);
});

test("enableUsbDrive returns true when CircuitPython restores the drive", async () => {
    const repl = new REPL();
    repl.runCode = async (code) => {
        assert.match(code, /storage\.enable_usb_drive\(\)/);
        return "USB_DRIVE_ENABLED True\n";
    };

    assert.equal(await repl.enableUsbDrive(), true);
});

test("enableUsbDrive returns false when restoring the drive fails", async () => {
    const repl = new REPL();
    repl.runCode = async () => "USB_DRIVE_ENABLED False\n";

    assert.equal(await repl.enableUsbDrive(), false);
});
