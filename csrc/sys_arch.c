#include "lwip/sys.h"
#include <emscripten.h>

void sys_init(void) {
}

u32_t sys_now(void) {
    return (u32_t)emscripten_get_now();
}
