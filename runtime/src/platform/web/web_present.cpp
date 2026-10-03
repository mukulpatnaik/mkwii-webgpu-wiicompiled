#if defined(__EMSCRIPTEN__)
#include "web_present.h"

#include "web_pacing.h"
#include "web_performance.h"

#include <emscripten/em_asm.h>
#include <emscripten/em_js.h>
#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" void aurora_web_set_display_tied_present(bool enabled);
extern "C" void aurora_web_set_frame_stamp(double stampMs);
extern "C" int aurora_web_present_due(double cutoffMs, double periodMs, int newestNow, double* stampMs,
                                      int* dropped);
extern "C" uint32_t aurora_web_take_queue_dropped();
extern "C" void aurora_web_set_wait_hook(void (*hook)());

// The display callback lives on the game's worker (the thread that owns the OffscreenCanvas). Each
// callback records its frame time and wakes a pending wait; C++ then presents from the resumed
// call, which still runs inside the callback's microtask checkpoint, so Chrome takes the frame at
// the end of that animation frame. Mode: 1 requestAnimationFrame, 2 timer at a fixed rate.
EM_JS(int, mkw_present_start, (double timerHz), {
  if (globalThis.__mkwPresent) return globalThis.__mkwPresent.mode;
  const s = globalThis.__mkwPresent = { mode: 0, waiter: null, tickTs: 0, pending: false };
  const channel = new MessageChannel();
  const queued = [];
  channel.port1.onmessage = () => { const f = queued.shift(); if (f) f(); };
  const word = new Int32Array(new SharedArrayBuffer(4));
  // A timeout that does not inherit setTimeout's 4 ms clamp for nested timers.
  s.sleep = (ms) => new Promise((resolve) => {
    if (ms > 0 && typeof Atomics.waitAsync === 'function') {
      const r = Atomics.waitAsync(word, 0, 0, ms);
      if (r.async) { r.value.then(() => resolve()); return; }
    }
    queued.push(resolve);
    channel.port2.postMessage(0);
  });
  const onTick = (ts) => {
    s.tickTs = ts;
    s.pending = true;
    const w = s.waiter;
    if (w) { s.waiter = null; w(1); return; }
    // The game may instead be suspended in Aurora's staging-map wait at the start of a frame; wake
    // it so the callback is still served inside this animation frame (aurora_web_set_wait_hook).
    const mapWait = globalThis.__auroraMapResolve;
    if (mapWait) mapWait();
  };
  if (timerHz > 0) {
    // Emulated display: callbacks on an exact grid of 1000/timerHz ms. A grid point missed while
    // the worker was busy is folded into the next callback, like a skipped BeginFrame.
    const period = 1000 / timerHz;
    let next = performance.now() + period;
    const loop = () => {
      const now = performance.now();
      if (now >= next) {
        const ts = next + Math.floor((now - next) / period) * period;
        next = ts + period;
        onTick(ts);
      }
      s.sleep(Math.max(0, next - performance.now())).then(loop);
    };
    s.sleep(period).then(loop);
    s.mode = 2;
  } else if (typeof requestAnimationFrame === 'function') {
    // With the frame-rate limit off (--disable-frame-rate-limit) Chrome runs a worker's callbacks
    // back to back, over 10000 a second, and waking the game for each starves it. Callbacks closer
    // than 1.5 ms (a display above ~660 Hz) re-arm after a short timer instead.
    let last = -1e9;
    const frame = (ts) => {
      if (ts - last < 1.5) { s.sleep(1.5).then(() => requestAnimationFrame(frame)); return; }
      last = ts;
      requestAnimationFrame(frame);
      onTick(ts);
    };
    requestAnimationFrame(frame);
    s.mode = 1;
  }
  return s.mode;
});

// Age (ms) of the display callback not yet served, or -1. Clears it.
EM_JS(double, mkw_present_take_tick, (), {
  const s = globalThis.__mkwPresent;
  if (!s || !s.pending) return -1;
  s.pending = false;
  return Math.max(0, performance.now() - s.tickTs);
});

// Yields to the browser until the next display callback or timeoutMs, whichever is first (0: one
// pass of the event loop). Returns 1 when woken by a callback.
EM_ASYNC_JS(int, mkw_present_wait, (double timeoutMs), {
  const s = globalThis.__mkwPresent;
  if (s.pending) return 1;
  return await new Promise((resolve) => {
    s.waiter = resolve;
    s.sleep(timeoutMs).then(() => {
      if (s.waiter === resolve) { s.waiter = null; resolve(0); }
    });
  });
});

namespace WebPresent {
namespace {

using Clock = std::chrono::steady_clock;

double NowMs() {
    return std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count();
}

bool s_initialized = false;
bool s_enabled = false;
int s_mode = 0;           // 0 present on encode, 1 requestAnimationFrame, 2 timer
double s_timerHz = 0.0;
double s_lastTickTime = 0.0;      // frame time of the previous served callback
double s_lastTickServed = 0.0;    // when it was served
double s_lastPresentTick = 0.0;   // frame time of the callback that last showed a new frame
double s_lastImmediatePresent = 0.0;
double s_lastStamp = 0.0;           // VI stamp of the frame being sealed
uint32_t s_ticksSincePresent = 0;
constexpr double kStalledMs = 100.0;   // no callbacks for this long: hidden tab, present directly

// Recent VI retrace times, to count simulation steps between two display callbacks.
std::array<double, 16> s_retraceRing{};
uint32_t s_retraceHead = 0;

// Report counters: written by the game thread, read and reset by the diagnostics thread.
struct Stat {
    std::atomic<uint64_t> n{0}, sumUs{0}, sumSqUs2{0}, maxUs{0};
    void Add(double ms) {
        const uint64_t us = static_cast<uint64_t>(std::clamp(ms, 0.0, 1.0e6) * 1000.0);
        n.fetch_add(1, std::memory_order_relaxed);
        sumUs.fetch_add(us, std::memory_order_relaxed);
        sumSqUs2.fetch_add(us * us, std::memory_order_relaxed);
        uint64_t old = maxUs.load(std::memory_order_relaxed);
        while (old < us && !maxUs.compare_exchange_weak(old, us, std::memory_order_relaxed)) {}
    }
    // mean, stdev, max (ms); resets.
    void Take(double& mean, double& stdev, double& max, uint64_t& count) {
        count = n.exchange(0);
        const double sum = sumUs.exchange(0) / 1000.0;
        const double sumSq = sumSqUs2.exchange(0) / 1.0e6;
        max = maxUs.exchange(0) / 1000.0;
        mean = count ? sum / count : 0.0;
        stdev = count ? std::sqrt(std::max(0.0, sumSq / count - mean * mean)) : 0.0;
    }
};
Stat s_tickInterval, s_presentInterval, s_serviceDelay, s_frameAge, s_immediateInterval;
std::array<std::atomic<uint32_t>, 5> s_ticksPerFrame{};   // shown for 1, 2, 3, 4, 5+ callbacks
std::array<std::atomic<uint32_t>, 4> s_stepsPerTick{};    // 0, 1, 2, 3+ VI steps since the last one
std::atomic<uint32_t> s_ticks{0}, s_newFrames{0}, s_repeats{0}, s_dropped{0}, s_fallback{0};
std::atomic<uint32_t> s_retraces{0};

void ReadOptions() {
    const char* present = std::getenv("MKW_WEB_PRESENT");
    const char* hz = std::getenv("MKW_WEB_RAF_HZ");
    // The page passes most options as MKW_WEB_* variables; these two are also read straight from
    // the page URL so they work without a page change.
    const int immediate = present ? (std::strcmp(present, "immediate") == 0)
                                  : MAIN_THREAD_EM_ASM_INT({
                                        return new URLSearchParams(location.search).get('present') === 'immediate' ? 1 : 0;
                                    });
    s_timerHz = hz ? std::atof(hz) : MAIN_THREAD_EM_ASM_DOUBLE({
        const v = parseFloat(new URLSearchParams(location.search).get('rafhz'));
        return v > 0 ? v : 0;
    });
    if (s_timerHz < 0.0) s_timerHz = 0.0;
    s_enabled = !immediate;
}

void ServeTick(double ageMs) {
    const double now = NowMs();
    const double tickTime = now - ageMs;
    s_ticks.fetch_add(1, std::memory_order_relaxed);
    if (s_lastTickTime != 0.0) s_tickInterval.Add(tickTime - s_lastTickTime);
    // VI steps whose retrace fell between the previous callback and this one.
    uint32_t steps = 0;
    for (const double t : s_retraceRing) {
        if (t > s_lastTickTime && t <= tickTime) ++steps;
    }
    if (s_lastTickTime != 0.0) s_stepsPerTick[std::min<uint32_t>(steps, 3)].fetch_add(1, std::memory_order_relaxed);
    s_lastTickTime = tickTime;
    s_lastTickServed = now;
    ++s_ticksSincePresent;

    // One VI period of latency: the newest frame whose retrace came at least a period before this
    // refresh. It is normally finished well before then, and the choice depends only on the two
    // clocks, never on how long a frame took.
    const double period = WebPacing::RetraceIntervalMs();
    double stamp = 0.0;
    int dropped = 0;
    const int presented = aurora_web_present_due(tickTime - period, period, 0, &stamp, &dropped);
    if (dropped) s_dropped.fetch_add(static_cast<uint32_t>(dropped), std::memory_order_relaxed);
    if (presented) {
        s_newFrames.fetch_add(1, std::memory_order_relaxed);
        s_serviceDelay.Add(now - tickTime);
        s_frameAge.Add(tickTime - stamp);
        if (s_lastPresentTick != 0.0) {
            s_presentInterval.Add(tickTime - s_lastPresentTick);
            s_ticksPerFrame[std::min<uint32_t>(s_ticksSincePresent, 5) - 1].fetch_add(1, std::memory_order_relaxed);
        }
        s_lastPresentTick = tickTime;
        s_ticksSincePresent = 0;
    } else {
        s_repeats.fetch_add(1, std::memory_order_relaxed);
    }
}

void ServePendingTick() {
    const double age = mkw_present_take_tick();
    if (age >= 0.0) ServeTick(age);
}

} // namespace

void Init() {
    if (s_initialized) return;
    s_initialized = true;
    ReadOptions();
    if (s_enabled) {
        s_mode = mkw_present_start(s_timerHz);
        if (s_mode == 0) s_enabled = false;   // no requestAnimationFrame on this worker
    }
    if (s_enabled) aurora_web_set_wait_hook(&ServePendingTick);
    aurora_web_set_display_tied_present(s_enabled);
    if (!s_enabled) {
        std::printf("[web-pace] present on encode (display callback off)\n");
    } else if (s_mode == 2) {
        std::printf("[web-pace] present at display callback: emulated %.2f Hz timer (rafhz), simulation stays on the VI clock\n",
                    s_timerHz);
    } else {
        std::printf("[web-pace] present at display callback: requestAnimationFrame, simulation stays on the VI clock\n");
    }
}

bool Enabled() { return s_enabled; }

void StampFrame(double viStampMs) {
    if (!s_initialized) Init();
    s_lastStamp = viStampMs;
    if (s_enabled) aurora_web_set_frame_stamp(viStampMs);
}

void AfterFrameQueued() {
    if (!s_initialized) Init();
    const double now = NowMs();
    if (!s_enabled) {
        // The frame was handed to the canvas inside aurora_end_frame, just now.
        if (s_lastImmediatePresent != 0.0) s_immediateInterval.Add(now - s_lastImmediatePresent);
        s_lastImmediatePresent = now;
        s_frameAge.Add(now - s_lastStamp);
        return;
    }
    // One pass of the event loop (the yield that presenting used to do): a display callback that
    // came while this frame was being made runs now and presents.
    mkw_present_wait(0.0);
    ServePendingTick();
    if (NowMs() - s_lastTickServed > kStalledMs) {
        // Hidden tab or no callbacks yet: present directly, as before, so the canvas stays live.
        double stamp = 0.0;
        int dropped = 0;
        if (aurora_web_present_due(0.0, 0.0, 1, &stamp, &dropped)) s_fallback.fetch_add(1, std::memory_order_relaxed);
    }
}

double IdleWaitUntil(double deadlineMs) {
    double idle = 0.0;
    for (;;) {
        ServePendingTick();
        const double now = NowMs();
        if (now >= deadlineMs) break;
        mkw_present_wait(deadlineMs - now);
        idle += NowMs() - now;
    }
    return idle;
}

void NoteRetrace(double viStampMs) {
    s_retraces.fetch_add(1, std::memory_order_relaxed);
    if (s_enabled) s_retraceRing[s_retraceHead++ % s_retraceRing.size()] = viStampMs;
}

void Report(double elapsedMs) {
    const double seconds = elapsedMs / 1000.0;
    const uint32_t retraces = s_retraces.exchange(0);
    if (!s_initialized) return;
    if (!s_enabled) {
        double mean, stdev, max, ageMean, ageStdev, ageMax;
        uint64_t n, ageN;
        s_immediateInterval.Take(mean, stdev, max, n);
        s_frameAge.Take(ageMean, ageStdev, ageMax, ageN);
        // age_ms: from the VI retrace that started a frame to handing it to the canvas.
        std::printf("[web-pace] present on encode: vi_steps/s=%.1f presents/s=%.1f present_interval_ms mean=%.2f "
                    "stdev=%.2f max=%.2f age_ms mean=%.2f max=%.2f\n",
                    retraces / seconds, n / seconds, mean, stdev, max, ageMean, ageMax);
        return;
    }
    double tickMean, tickStdev, tickMax, presMean, presStdev, presMax, delayMean, delayStdev, delayMax, ageMean,
        ageStdev, ageMax;
    uint64_t tickN, presN, delayN, ageN;
    s_tickInterval.Take(tickMean, tickStdev, tickMax, tickN);
    s_presentInterval.Take(presMean, presStdev, presMax, presN);
    s_serviceDelay.Take(delayMean, delayStdev, delayMax, delayN);
    s_frameAge.Take(ageMean, ageStdev, ageMax, ageN);
    const uint32_t ticks = s_ticks.exchange(0), frames = s_newFrames.exchange(0), repeats = s_repeats.exchange(0);
    const uint32_t dropped = s_dropped.exchange(0) + aurora_web_take_queue_dropped();
    const uint32_t fallback = s_fallback.exchange(0);
    uint32_t perFrame[5], perTick[4];
    for (size_t i = 0; i < 5; ++i) perFrame[i] = s_ticksPerFrame[i].exchange(0);
    for (size_t i = 0; i < 4; ++i) perTick[i] = s_stepsPerTick[i].exchange(0);
    // vi_steps/s: simulation steps (VI retraces). callbacks/s: display refreshes served.
    // shown_for: how many refreshes each frame stayed on screen (1:n 2:n ...; even = one bucket at
    // 60 or 120 Hz, a fixed 2/3 mix at 144 Hz). steps_per_callback: VI steps between two refreshes.
    // frame_interval_ms: refresh time of one new frame to the next. late_ms: callback to present.
    // age_ms: from the VI retrace that started a frame to the refresh that shows it (latency).
    std::printf("[web-pace] present at display callback (%s): vi_steps/s=%.1f callbacks/s=%.1f new_frames/s=%.1f "
                "repeats=%u dropped=%u direct=%u callback_ms mean=%.2f stdev=%.2f max=%.2f frame_interval_ms "
                "mean=%.2f stdev=%.2f max=%.2f shown_for 1:%u 2:%u 3:%u 4:%u 5+:%u steps_per_callback 0:%u 1:%u "
                "2:%u 3+:%u late_ms mean=%.2f max=%.2f age_ms mean=%.2f max=%.2f\n",
                s_mode == 2 ? "timer" : "rAF", retraces / seconds, ticks / seconds, frames / seconds, repeats,
                dropped, fallback, tickMean, tickStdev, tickMax, presMean, presStdev, presMax, perFrame[0],
                perFrame[1], perFrame[2], perFrame[3], perFrame[4], perTick[0], perTick[1], perTick[2], perTick[3],
                delayMean, delayMax, ageMean, ageMax);
}

} // namespace WebPresent
#endif
