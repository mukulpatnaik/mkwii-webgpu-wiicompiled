#pragma once

#if defined(__EMSCRIPTEN__)
#include <cstdint>

// Display-tied presentation for the web build (Minithena's known issue 2).
//
// The simulation keeps its own VI clock (hle/vi.cpp): one guest frame per retrace, exactly as
// before. What changes is when a finished frame reaches the screen. Instead of handing each frame
// to the canvas the moment it is encoded, Aurora queues it with the VI time that started it, and
// the frame is presented from the game worker's requestAnimationFrame callback: at each display
// refresh the newest frame whose VI period began at least one period earlier is shown (one fixed
// period of latency, so the frame is finished by then). Both clocks are jitter-free, so which
// frame a refresh shows no longer depends on how long the frame took to render: at 60 Hz each
// refresh shows the next frame, at 120 Hz each frame is shown for exactly two refreshes, and at
// 144 Hz in a steady 2-3 pattern. A frame drawn inside the callback is handed to the compositor
// for that refresh; frames drawn whenever they were encoded were not all forwarded (a Chrome trace
// of a race: about one refresh in ten repeated the previous frame while the game presented 60/s).
//
// The VI waits on the web yield to the browser (instead of blocking the worker) and Aurora's
// staging-map wait at the start of a frame runs our hook, so a callback that lands in either is
// served inside its animation frame; one that lands while the game is busy runs at the next
// yield, right after the frame is encoded.
//
// Page options (read from the page URL): "?present=immediate" restores the old present-on-encode
// behaviour; "?rafhz=<hz>" replaces requestAnimationFrame with a timer at <hz> to emulate another
// display rate (the physical display still shows 60 Hz; see the report for what it measures).
namespace WebPresent {

// Reads the options and starts the frame callback. Call once the renderer exists (first frame).
void Init();

// True when frames are queued for the display callback instead of presented on encode.
bool Enabled();

// Called by vi.cpp before a frame is sealed: the VI retrace (steady_clock ms) that started it.
void StampFrame(double viStampMs);

// Called right after a frame was sealed and queued: lets a display callback that came during the
// frame's work run now, and presents directly when callbacks have stopped (hidden tab).
void AfterFrameQueued();

// Waits until deadlineMs (steady_clock ms) while yielding to the browser, presenting at each
// display callback. Returns the time spent idle (ms, presenting excluded).
double IdleWaitUntil(double deadlineMs);

// One VI retrace was delivered; viStampMs is its time on the VI timeline (steady_clock ms).
void NoteRetrace(double viStampMs);

// One [web-pace] present line per report period (diagnostics thread).
void Report(double elapsedMs);

} // namespace WebPresent
#endif
