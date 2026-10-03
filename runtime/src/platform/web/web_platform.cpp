// Web (Emscripten) start-up: file system layout before anything reads configuration.
//
// The disc is mounted at /game with the WASMFS fetch backend, from one of two sources:
//  - The player's own disc image (the default when the site has no game folder): the page reads
//    the picked file in a worker (mkw_disc_worker.js) and names a BroadcastChannel in
//    MKW_WEB_DISC, over which the backend's JS half (mkw_discfs.js) asks that worker for data.
//  - A staged copy: the page is served next to a `game/` folder holding the extracted disc
//    (`game/DATA/sys`, `game/DATA/files`), read in chunks with HTTP range requests the first
//    time the game touches a file (mkw_fetchfs.js).
// Either way /game/manifest.txt lists every directory ("d <path>") and file ("f <size> <path>"),
// and each listed file becomes a lazily read file. User state (Config.toml, NAND, logs) lives in
// memory under /data for now; an optional `game/save/rksys.dat` seeds the NAND save.
#if defined(__EMSCRIPTEN__)

#include "web_platform.h"
#include "web_guest_hooks.h"
#include "web_guest_profile.h"
#include "web_performance.h"
#include "region/guest_region.h"

#include "fiber_manager.h"
#include "guest_flat_memory.h"
#include "recomp_mod_loader.h"
#include "runtime_config.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <thread>
#include <unordered_map>
#include <vector>

#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>
#include <emscripten/heap.h>
#include <malloc.h>
#include <emscripten/proxying.h>
#include <emscripten/wasmfs.h>
#include <pthread.h>

#include <cerrno>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace HostContext {
extern std::atomic<uint32_t> g_webContextSwitches;
extern std::atomic<uint64_t> g_webSwitchNanos;
}

namespace WebPlatform {
namespace {
constexpr const char* kGameMount = "/game";
constexpr uint32_t kFetchChunkSize = 1u << 20;

// The page's BroadcastChannel to its disc reader worker, or empty for a staged game folder.
std::string g_discChannel;
// For a staged game folder, the copy of game/manifest-v2.txt the page already downloaded (a blob:
// URL), or empty to download it.
std::string g_manifestUrl;

// Entries created inside a fetch-backed directory are fetch-backed themselves (their URL is
// derived from the path), so ordinary mkdir/open build the tree.
int CreateFile(const std::string& path) {
    const int fd = open(path.c_str(), O_RDONLY | O_CREAT | O_EXCL, 0444);
    if (fd < 0) {
        return fd;
    }
    close(fd);
    return 0;
}
} // namespace

void MountGame() {
    // Read on the WASMFS worker when the backend is created (mkw_fetchfs.js), so set it first.
    if (const char* channel = std::getenv("MKW_WEB_DISC"); channel && *channel) {
        g_discChannel = channel;
    }
    if (const char* manifestUrl = std::getenv("MKW_WEB_MANIFEST_URL"); manifestUrl && *manifestUrl) {
        g_manifestUrl = manifestUrl;
    }
    const bool localDisc = !g_discChannel.empty();
    backend_t fetch = wasmfs_create_fetch_backend("game", kFetchChunkSize);
    if (!fetch || wasmfs_create_directory(kGameMount, 0777, fetch) != 0) {
        throw std::runtime_error("unable to mount the game folder");
    }
    const std::string manifestPath = std::string(kGameMount) + "/manifest.txt";
    if (CreateFile(manifestPath) != 0) {
        throw std::runtime_error("unable to create the game manifest entry");
    }

    std::ifstream manifest(manifestPath);
    if (!manifest) {
        throw std::runtime_error(localDisc ? "the disc image could not be read; reload the page and choose it again"
                                           : "game/manifest.txt is missing; run the web deploy script");
    }
    size_t files = 0;
    std::string line;
    while (std::getline(manifest, line)) {
        if (line.size() < 3 || line[1] != ' ') {
            continue;
        }
        // "d <path>" or "f <size> <path>"; the size is only needed by mkw_fetchfs.js.
        const size_t pathStart = line[0] == 'f' ? line.find(' ', 2) + 1 : 2;
        if (pathStart == 0 || pathStart >= line.size()) {
            continue;
        }
        const std::string path = std::string(kGameMount) + "/" + line.substr(pathStart);
        const int result = line[0] == 'd' ? mkdir(path.c_str(), 0777)
                         : line[0] == 'f' ? CreateFile(path)
                                          : 0;
        if (result != 0) {
            throw std::runtime_error("unable to create " + path + " from game/manifest.txt: " +
                                     std::strerror(errno));
        }
        files += line[0] == 'f';
    }
    if (manifest.bad() || files == 0 || !std::filesystem::exists("/game/DATA/sys/fst.bin")) {
        throw std::runtime_error(localDisc ? "The disc image could not be read. Reload the page and choose it again."
                                           : "Game files could not be loaded. Reload the page after signing in.");
    }
    std::printf("[web] mounted %zu game files at %s from %s (game thread %p)\n", files, kGameMount,
                localDisc ? "the local disc image" : "the staged game folder",
                reinterpret_cast<void*>(pthread_self()));
}

void ReportFatalError(const char* message) noexcept {
    MAIN_THREAD_EM_ASM({
        if (Module.onAbort) Module.onAbort(UTF8ToString($0));
    }, message);
}

std::string DefaultConfigText() {
    return "[video]\n"
           "widescreen = true\n"
           "resolution_multiplier = 1.0\n"
           "graphics_api = \"auto\"\n"
           "\n"
           "[paths]\n"
           "dvd_root = \"/game/DATA\"\n";
}

namespace {
bool EnvFlag(const char* name) {
    const char* value = std::getenv(name);
    return value && *value == '1';
}

bool OpfsAvailable() {
    return EM_ASM_INT({
        return typeof navigator !== 'undefined' && navigator.storage &&
               typeof navigator.storage.getDirectory === 'function' ? 1 : 0;
    }) != 0;
}
} // namespace

void UsePersistentStorage() {
    namespace fs = std::filesystem;
    std::error_code ec;
    if (EnvFlag("MKW_WEB_SESSION_STORAGE") || !OpfsAvailable()) {
        std::printf("[web] browser storage (OPFS) unavailable: settings and saves last this session only\n");
    } else if (backend_t opfs = wasmfs_create_opfs_backend();
               opfs && wasmfs_create_directory("/persist", 0777, opfs) == 0) {
        const fs::path root = fs::path("/persist") / "WiiCompiled";
        fs::create_directories(root, ec);
        const fs::path config = root / "Config.toml";
        // A file left empty (a tab closed while it was being rewritten) is as good as missing.
        if (!fs::exists(config, ec) || fs::file_size(config, ec) == 0) {
            std::ofstream(config) << DefaultConfigText();
        }
        RuntimePlatform::g_webDataRoot = "/persist";
        RuntimeConfigFile::ReloadAfterStorageSwitch();
        std::printf("[web] settings, key bindings and saves are kept in this browser's storage\n");
    } else {
        std::printf("[web] could not mount browser storage: settings and saves last this session only\n");
    }

    // The disc is always mounted here, whatever the saved file says: a damaged or hand-edited
    // Config.toml must not leave the game without its data.
    const_cast<RuntimeUserConfig&>(RuntimeConfigFile::Get()).dvdRoot = std::string(kGameMount) + "/DATA";

    // "?muted" mutes this session without changing the saved setting.
    if (EnvFlag("MKW_WEB_MUTED")) {
        const_cast<RuntimeUserConfig&>(RuntimeConfigFile::Get()).audioMuted = true;
    }

    // Seed the NAND with the save staged next to the disc: once, or again for "?resetsave".
    const fs::path stagedSave = std::string(kGameMount) + "/save/rksys.dat";
    // The save's NAND folder is named after this build's release (524d4345 NTSC-U, 524d4350 PAL);
    // mkw_saves.js imports into and exports from the same place.
    char titleDir[9];
    std::snprintf(titleDir, sizeof(titleDir), "%08x", unsigned(MKW_REGION_GAME_CODE));
    const fs::path nandSave = RuntimeConfigFile::ApplicationDataDirectory() / "NAND/title/00010004" /
        titleDir / "data/rksys.dat";
    const bool reset = EnvFlag("MKW_WEB_RESET_SAVE");
    if (fs::exists(stagedSave, ec) && (reset || !fs::exists(nandSave, ec))) {
        fs::create_directories(nandSave.parent_path(), ec);
        fs::copy_file(stagedSave, nandSave, fs::copy_options::overwrite_existing, ec);
        // The copy inherits the read-only mode of the served file; the game must write its save.
        if (!ec) {
            fs::permissions(nandSave, fs::perms::owner_read | fs::perms::owner_write,
                            fs::perm_options::replace, ec);
        }
        std::printf("[web] %s the staged save into the NAND\n", ec ? "could not copy" : "copied");
    }
}

void StartWatchdog() {
    // Other threads can read the game thread's state: it all lives in shared linear memory.
    const uint32_t* translatedAddress = &RecompMod::g_currentTranslatedExecutionAddress;
    std::thread([translatedAddress] {
        uint32_t lastSwitches = 0;
        double previousReport = WebPerformance::Now();
        for (;;) {
            std::this_thread::sleep_for(std::chrono::seconds(3));
            const uint32_t switches = HostContext::g_webContextSwitches.load(std::memory_order_relaxed);
            uint32_t runningThread = 0;
            if (const uint8_t* p = GuestFlat::HostPointer(0x800000e4u)) {
                runningThread = (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) |
                                (uint32_t(p[2]) << 8) | uint32_t(p[3]);
            }
            std::printf("[web] watchdog: switches=%u (+%u) retracePending=%u guestThread=%08x "
                        "osThread=%08x translated=%08x heap=%zuMB used=%zuMB switchus=%.0f\n",
                        switches, switches - lastSwitches,
                        Fiber::g_viRetracePendingCount.load(std::memory_order_relaxed),
                        Fiber::GuestFiberManager::GetCurrentGuestThreadForWatchdog(), runningThread,
                        *reinterpret_cast<const volatile uint32_t*>(translatedAddress),
                        emscripten_get_heap_size() >> 20, size_t(mallinfo().uordblks) >> 20,
                        (switches - lastSwitches) ? double(HostContext::g_webSwitchNanos.exchange(0)) / 1000.0 / (switches - lastSwitches) : 0.0);
            lastSwitches = switches;
            if (WebPerformance::Enabled()) {
                const double now = WebPerformance::Now();
                WebPerformance::Report(now - previousReport);
                WebGuestHooks::Report(now - previousReport);
                previousReport = now;
            }
        }
    }).detach();

    if (!WebPerformance::ProfilerEnabled()) return;
#if MKW_WEB_GUEST_PROFILE
    // Diagnostic build only (web_guest_profile.h): innermost guest function and inclusive counts
    // from the per-thread guest call stacks, every 3 s.
    std::thread([] {
        std::unordered_map<uint32_t, uint32_t> self, incl;
        uint32_t total = 0;
        auto reportAt = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        const auto top = [](const std::unordered_map<uint32_t, uint32_t>& counts, size_t n, uint32_t total) {
            std::vector<std::pair<uint32_t, uint32_t>> v(counts.begin(), counts.end());
            std::sort(v.begin(), v.end(), [](auto& a, auto& b) { return a.second > b.second; });
            std::string line;
            for (size_t i = 0; i < v.size() && i < n; ++i) {
                char item[48];
                std::snprintf(item, sizeof(item), " %08x:%.1f%%", v[i].first, 100.0 * v[i].second / total);
                line += item;
            }
            return line;
        };
        for (;;) {
            std::this_thread::sleep_for(std::chrono::microseconds(250));
            const WebGuestProfile::Stack* s = WebGuestProfile::g_current;
            if (!s) continue;
            uint32_t depth = s->depth;
            if (depth > WebGuestProfile::kMaxDepth) depth = WebGuestProfile::kMaxDepth;
            uint32_t frames[WebGuestProfile::kMaxDepth];
            for (uint32_t i = 0; i < depth; ++i) frames[i] = s->addr[i];
            ++total;
            const uint32_t leaf = depth ? frames[depth - 1] : 0;
            ++self[leaf];
            std::vector<uint32_t> seen;
            for (uint32_t i = 0; i < depth; ++i) {
                if (std::find(seen.begin(), seen.end(), frames[i]) != seen.end()) continue;
                seen.push_back(frames[i]);
                ++incl[frames[i]];
            }
            if (std::chrono::steady_clock::now() < reportAt) continue;
            std::printf("[web-gprof] self samples=%u%s\n", total, top(self, 24, total).c_str());
            std::printf("[web-gprof] incl samples=%u%s\n", total, top(incl, 40, total).c_str());
            self.clear(); incl.clear();
            total = 0;
            reportAt = std::chrono::steady_clock::now() + std::chrono::seconds(3);
        }
    }).detach();
#endif
    // "?log" only: a statistical profile at guest-function granularity. The translated code
    // publishes the target of each indirect call (RecompMod::ScopedTranslatedExecutionAddress), so
    // sampling it shows which virtual calls the game thread is inside of; direct calls are not seen.
    std::thread([translatedAddress] {
        std::unordered_map<uint32_t, uint32_t> counts;
        uint32_t total = 0;
        auto reportAt = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        for (;;) {
            std::this_thread::sleep_for(std::chrono::microseconds(300));
            const uint32_t sample = *reinterpret_cast<const volatile uint32_t*>(translatedAddress);
            ++counts[sample];
            WebPerformance::PushSample(WebPerformance::Now(), sample);
            ++total;
            if (std::chrono::steady_clock::now() < reportAt) continue;
            std::vector<std::pair<uint32_t, uint32_t>> top(counts.begin(), counts.end());
            std::sort(top.begin(), top.end(), [](auto& a, auto& b) { return a.second > b.second; });
            std::string line = "[web-prof] samples=" + std::to_string(total);
            for (size_t i = 0; i < top.size() && i < 14; ++i) {
                char item[40];
                std::snprintf(item, sizeof(item), " %08x:%.1f%%", top[i].first, 100.0 * top[i].second / total);
                line += item;
            }
            std::printf("%s\n", line.c_str());
            counts.clear();
            total = 0;
            reportAt = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        }
    }).detach();
}

} // namespace WebPlatform

extern "C" {
// mkw_fetchfs.js asks which source the /game mount reads (see MountGame).
EMSCRIPTEN_KEEPALIVE const char* mkw_web_disc_channel() {
    return WebPlatform::g_discChannel.c_str();
}

// The staged manifest the page already has, as a blob: URL, or "" (mkw_fetchfs.js).
EMSCRIPTEN_KEEPALIVE const char* mkw_web_manifest_url() {
    return WebPlatform::g_manifestUrl.c_str();
}

// The release this build was translated from (e.g. "RMCE01"): the page accepts only a disc
// image of that release (shell.html).
EMSCRIPTEN_KEEPALIVE const char* mkw_web_build_game_id() {
    return MKW_REGION_GAME_ID;
}
}

// Replaces Emscripten's html5/callback.c forwarder (same symbol; the linker prefers this
// definition). Browser events are queued to the thread that registered their handler; the stock
// version asserts when that thread's mailbox is closed, which a window resize could trigger.
// Log the dead target and drop the event instead.
extern "C" {
typedef bool (*mkw_event_callback)(int event_type, void* event_data, void* user_data);
struct MkwCallbackArgs {
    mkw_event_callback callback;
    int eventType;
    void* userData;
    alignas(max_align_t) uint8_t eventData[];
};

static void MkwRunCallback(void* arg) {
    auto* args = static_cast<MkwCallbackArgs*>(arg);
    args->callback(args->eventType, args->eventData, args->userData);
    std::free(arg);
}

void _emscripten_run_callback_on_thread(pthread_t target, mkw_event_callback callback, int eventType,
                                        void* eventData, size_t eventDataSize, void* userData) {
    auto* args = static_cast<MkwCallbackArgs*>(std::malloc(sizeof(MkwCallbackArgs) + eventDataSize));
    args->callback = callback;
    args->eventType = eventType;
    args->userData = userData;
    std::memcpy(args->eventData, eventData, eventDataSize);
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), target, MkwRunCallback, args)) {
        std::free(args);
        static std::atomic<int> reported{0};
        if (reported.fetch_add(1) < 8) {
            std::fprintf(stderr, "[web] dropped browser event %d for exited thread %p\n", eventType,
                         reinterpret_cast<void*>(target));
        }
    }
}
}

// Configuration is read during static initialization, so the default Config.toml has to exist
// before any other constructor runs. (The fetch mount cannot be created this early: constructors
// run on the browser's main thread, so MountGame waits for main().)
__attribute__((constructor(101))) static void WriteDefaultConfig() {
    const std::filesystem::path configPath = RuntimeConfigFile::ResolveConfigPath();
    std::error_code ec;
    std::filesystem::create_directories(configPath.parent_path(), ec);
    if (std::filesystem::exists(configPath, ec)) {
        return;
    }
    std::ofstream(configPath) << WebPlatform::DefaultConfigText();
}

#endif
