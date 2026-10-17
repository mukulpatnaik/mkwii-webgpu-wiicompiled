#pragma once

// Browser gamepads that Chrome does not report with its "standard" layout (many third-party
// pads) fall back to SDL's generic mapping in the web build, which puts their buttons in the
// wrong places. When the browser runs on Linux, the Gamepad API lists such a pad's buttons and
// axes in the same order as SDL's Linux joystick driver, with the D-pad hat as two extra axes,
// so SDL's own Linux mapping for that vendor and product can be used after translating the hat.
namespace WebGamepadFallback {

// Gives every connected joystick that still uses the generic mapping SDL's Linux mapping, when
// the browser runs on Linux and SDL knows the device. Cheap and idempotent: call it whenever a
// controller is added.
void Apply();

} // namespace WebGamepadFallback
