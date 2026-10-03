#pragma once
// The web build's guest hooks (web_guest_hooks, web_room_launch, web_race_warm, the benchmark
// report in web_performance) name Mario Kart Wii addresses as they are in the PAL executable
// (RMCP01) and are not yet in the per-region tables that tools/region generates. Until those
// identities are ported, the features compile only for PAL; other regions run without
// real-time catch-up, lag-wait removal, invite rooms and race-asset warming.
#include "region/guest_region.h"

#if defined(__EMSCRIPTEN__) && (MKW_REGION_GAME_CODE == 0x524D4350u)  // "RMCP"
#define MKW_WEB_PAL_HOOKS 1
#else
#define MKW_WEB_PAL_HOOKS 0
#endif
