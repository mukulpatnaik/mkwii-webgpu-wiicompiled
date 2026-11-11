#if defined(__EMSCRIPTEN__)
#include "web_gamepad_fallback.h"

#include <SDL3/SDL.h>
#include <emscripten/em_js.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>
#include <vector>

namespace {

// SDL's Linux mappings ("GUID,name,field:value,..."), extracted at configure time
// (runtime/CMakeLists.txt). Empty when the build has no vendored SDL source.
const char* const kLinuxMappings[] = {
#include "web_sdl_linux_gamepad_db.inc"
    nullptr,
};

// userAgentData is the reliable source in Chrome; navigator.platform is the fallback.
// ChromeOS and Android report themselves separately and are not treated as Linux.
EM_JS(int, mkw_web_browser_on_linux, (), {
    if (typeof navigator === 'undefined') return 0;
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /linux/i.test(platform) && !/android/i.test(platform) ? 1 : 0;
});

std::vector<std::string> Split(std::string_view text, char separator) {
    std::vector<std::string> parts;
    size_t start = 0;
    while (start <= text.size()) {
        const size_t end = text.find(separator, start);
        if (end == std::string_view::npos) {
            if (start < text.size()) parts.emplace_back(text.substr(start));
            break;
        }
        parts.emplace_back(text.substr(start, end - start));
        start = end + 1;
    }
    return parts;
}

// The 32-hex-digit GUID of a database entry: bus (LE16), CRC, vendor (LE16), 0, product (LE16), 0,
// version, driver bytes. Matches on bus, vendor and product; CRC and version are ignored.
bool GuidMatches(std::string_view guid, Uint16 bus, Uint16 vendor, Uint16 product) {
    if (guid.size() != 32) return false;
    char want[13];
    std::snprintf(want, sizeof(want), "%02x%02x%02x%02x%02x%02x", bus & 0xff, bus >> 8, vendor & 0xff,
                  vendor >> 8, product & 0xff, product >> 8);
    const std::string_view w(want);
    return guid.substr(0, 4) == w.substr(0, 4) && guid.substr(8, 4) == w.substr(4, 4) &&
           guid.substr(16, 4) == w.substr(8, 4) && guid.substr(12, 4) == "0000" && guid.substr(20, 4) == "0000";
}

// Rewrites a Linux mapping's fields for the browser: hat 0 becomes the two axes after the stick
// and trigger axes (the order Chrome lists a Linux pad's absolute axes in), CRC and platform
// fields are dropped. Returns an empty string when any input does not exist on this device.
std::string TranslateFields(const std::vector<std::string>& fields, int axes, int buttons) {
    const int hatAxis = axes - 2;  // left/right; up/down is the next one
    bool usesHat = false;
    int maxAxis = -1;
    std::string out;
    for (const std::string& field : fields) {
        const size_t colon = field.find(':');
        if (colon == std::string::npos) continue;
        const std::string key = field.substr(0, colon);
        std::string value = field.substr(colon + 1);
        if (key == "crc" || key == "platform") continue;
        if (key != "hint") {
            size_t at = 0;
            if (!value.empty() && (value[0] == '+' || value[0] == '-')) at = 1;
            if (at < value.size() && value[at] == 'h') {
                // "h0.1" up, "h0.2" right, "h0.4" down, "h0.8" left.
                if (value.compare(at, 3, "h0.") != 0) return {};
                const int direction = std::atoi(value.c_str() + at + 3);
                if (hatAxis < 0) return {};
                usesHat = true;
                switch (direction) {
                case 1: value = "-a" + std::to_string(hatAxis + 1); break;
                case 4: value = "+a" + std::to_string(hatAxis + 1); break;
                case 8: value = "-a" + std::to_string(hatAxis); break;
                case 2: value = "+a" + std::to_string(hatAxis); break;
                default: return {};
                }
            } else if (at < value.size() && value[at] == 'a') {
                const int index = std::atoi(value.c_str() + at + 1);
                if (index >= axes) return {};
                if (index > maxAxis) maxAxis = index;
            } else if (at < value.size() && value[at] == 'b') {
                if (std::atoi(value.c_str() + at + 1) >= buttons) return {};
            }
        }
        out += key + ":" + value + ",";
    }
    // The hat's two axes must come after every axis the mapping already uses.
    if (usesHat && maxAxis >= hatAxis) return {};
    return out;
}

std::string FindLinuxMapping(Uint16 vendor, Uint16 product, int axes, int buttons, std::string* name) {
    // USB first, then Bluetooth: the browser does not say which bus a pad is on.
    for (const Uint16 bus : {Uint16{0x03}, Uint16{0x05}}) {
        for (const char* const* entry = kLinuxMappings; *entry != nullptr; ++entry) {
            const std::vector<std::string> parts = Split(*entry, ',');
            if (parts.size() < 3 || !GuidMatches(parts[0], bus, vendor, product)) continue;
            const std::string fields =
                TranslateFields(std::vector<std::string>(parts.begin() + 2, parts.end()), axes, buttons);
            if (fields.empty()) continue;
            *name = parts[1];
            return fields;
        }
    }
    return {};
}

} // namespace

namespace WebGamepadFallback {

void Apply() {
    static const bool onLinux = mkw_web_browser_on_linux() != 0;
    if (!onLinux || kLinuxMappings[0] == nullptr) return;

    int count = 0;
    SDL_JoystickID* ids = SDL_GetJoysticks(&count);
    if (ids == nullptr) return;
    for (int i = 0; i < count; ++i) {
        const SDL_JoystickID id = ids[i];
        char* current = SDL_GetGamepadMappingForID(id);
        if (current == nullptr) continue;
        // "<guid>,<name>,..." where SDL's generic fallback mapping is named "*".
        const std::string_view text(current);
        const size_t comma = text.find(',');
        const bool generic = comma != std::string_view::npos && text.substr(comma + 1, 2) == "*,";
        SDL_free(current);
        if (!generic) continue;

        SDL_GUID guid = SDL_GetJoystickGUIDForID(id);
        Uint16 vendor = 0, product = 0;
        SDL_GetJoystickGUIDInfo(guid, &vendor, &product, nullptr, nullptr);
        SDL_Joystick* joystick = SDL_GetJoystickFromID(id);
        if (vendor == 0 || product == 0 || joystick == nullptr) continue;
        // A pad the browser reports in its standard layout already fits the generic mapping (SDL's
        // web backend gives it a hat for the D-pad); a Linux mapping is for the device's own order.
        if (SDL_GetNumJoystickHats(joystick) > 0) continue;
        const int axes = SDL_GetNumJoystickAxes(joystick);
        const int buttons = SDL_GetNumJoystickButtons(joystick);

        std::string name;
        const std::string fields = FindLinuxMapping(vendor, product, axes, buttons, &name);
        if (fields.empty()) {
            // Two events announce each new pad; say it once per device.
            static std::vector<SDL_JoystickID> reported;
            if (std::find(reported.begin(), reported.end(), id) != reported.end()) continue;
            reported.push_back(id);
            std::printf("[web-pad] %04x:%04x (%d buttons, %d axes) has no standard layout in this browser and no "
                        "SDL mapping fits it: set it up in F10 -> Controller settings\n",
                        vendor, product, buttons, axes);
            continue;
        }
        // Mappings never carry the name CRC (bytes 2-3 of the GUID); SDL matches without it.
        guid.data[2] = 0;
        guid.data[3] = 0;
        char guidText[33];
        SDL_GUIDToString(guid, guidText, sizeof(guidText));
        const std::string mapping = std::string(guidText) + "," + name + "," + fields;
        if (SDL_AddGamepadMapping(mapping.c_str()) < 0) {
            std::printf("[web-pad] could not apply SDL's mapping for %04x:%04x: %s\n", vendor, product, SDL_GetError());
        } else {
            std::printf("[web-pad] %04x:%04x: using SDL's Linux mapping \"%s\" (D-pad from axes %d/%d)\n", vendor,
                        product, name.c_str(), axes - 2, axes - 1);
        }
    }
    SDL_free(ids);
}

} // namespace WebGamepadFallback
#endif
