# SPDX-License-Identifier: GPL-3.0-or-later
# Build step for the browser disc reader (runtime/cmake/PublicProducts.cmake runs it with
# cmake -P): builds this crate with cargo for wasm32-unknown-unknown and places mkw_disc.wasm next
# to the page. A failure is a warning, not a failed web build: the page then reports that the disc
# reader is missing, and a staged game folder still plays.
#
# The crate is copied into the build directory first, so cargo never writes into the source tree:
# with MKW_NOD_SOURCE_DIR the patched nod source changes Cargo.lock, which must stay the committed
# one in git.
#
# Inputs (-D): CARGO, CRATE_DIR, WORK_DIR (in the build directory), OUTPUT (mkw_disc.wasm),
# STAMP, NOD_SOURCE_DIR (optional local nod checkout).
cmake_minimum_required(VERSION 3.16)

set(crate "${WORK_DIR}/crate")
file(REMOVE_RECURSE "${crate}/src")
file(MAKE_DIRECTORY "${crate}")
file(COPY "${CRATE_DIR}/Cargo.toml" "${CRATE_DIR}/Cargo.lock" "${CRATE_DIR}/src" DESTINATION "${crate}")

set(args build --release --target wasm32-unknown-unknown
    --manifest-path "${crate}/Cargo.toml" --target-dir "${WORK_DIR}/target")
if(NOD_SOURCE_DIR)
    list(APPEND args --config "patch.'https://github.com/encounter/nod'.nod.path='${NOD_SOURCE_DIR}/nod'")
else()
    list(APPEND args --locked)
endif()

execute_process(COMMAND "${CARGO}" ${args} WORKING_DIRECTORY "${crate}" RESULT_VARIABLE result)
set(built "${WORK_DIR}/target/wasm32-unknown-unknown/release/mkw_disc_wasm.wasm")
if(result EQUAL 0 AND EXISTS "${built}")
    execute_process(COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${built}" "${OUTPUT}")
else()
    # A reader left from an earlier build may not match the worker script built now.
    file(REMOVE "${OUTPUT}")
    message(WARNING "Building the browser disc reader with cargo failed (${result}): this web build "
                    "has no mkw_disc.wasm, so players cannot use their own disc image and only a staged "
                    "game folder plays. See docs/web-local-disc.md.")
endif()
# Written either way, so a failed build is retried when the crate changes rather than on every build.
file(TOUCH "${STAMP}")
