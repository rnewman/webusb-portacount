#ifndef CC_H
#define CC_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#ifndef BYTE_ORDER
#define BYTE_ORDER LITTLE_ENDIAN
#endif

#define LWIP_PLATFORM_DIAG(x) do { printf x; } while(0)
#define LWIP_PLATFORM_ASSERT(x) do { \
    printf("Assertion \"%s\" failed at %s:%d\n", x, __FILE__, __LINE__); \
    abort(); \
} while(0)

#define LWIP_RAND() ((u32_t)rand())

#endif /* CC_H */
