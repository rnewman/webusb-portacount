#ifndef LWIPOPTS_H
#define LWIPOPTS_H

/* NO_SYS: single-threaded, callback-driven, no OS abstractions */
#define NO_SYS                  1
#define LWIP_TIMERS             1
#define SYS_LIGHTWEIGHT_PROT    0

/* Memory */
#define MEM_SIZE                (16 * 1024)
#define MEM_ALIGNMENT           4
#define MEMP_NUM_PBUF           16
#define MEMP_NUM_TCP_PCB        4
#define MEMP_NUM_TCP_PCB_LISTEN 2
#define MEMP_NUM_TCP_SEG        32
#define MEMP_NUM_UDP_PCB        4
#define PBUF_POOL_SIZE          24
#define PBUF_POOL_BUFSIZE       1600

/* Protocols */
#define LWIP_IPV4               1
#define LWIP_IPV6               0
#define LWIP_TCP                1
#define LWIP_UDP                1
#define LWIP_ARP                1
#define LWIP_ETHERNET           1
#define LWIP_ICMP               1
#define LWIP_RAW                0
#define LWIP_AUTOIP             1   /* 169.254.x.x link-local addressing */
#define LWIP_DHCP               1   /* device is the DHCP server over RNDIS */
#define LWIP_DHCP_AUTOIP_COOP   1   /* fall back to AutoIP if DHCP fails */
#define LWIP_DNS                0
#define LWIP_IGMP               0
#define LWIP_SNMP               0

/* TCP tuning */
#define TCP_MSS                 1460
#define TCP_WND                 (4 * TCP_MSS)
#define TCP_SND_BUF             (4 * TCP_MSS)
#define TCP_SND_QUEUELEN        (4 * TCP_SND_BUF / TCP_MSS)

/* Debug (off for now) */
#define LWIP_DEBUG              0
#define LWIP_DBG_MIN_LEVEL      LWIP_DBG_LEVEL_WARNING

/* Checksums: all in software */
#define CHECKSUM_GEN_IP         1
#define CHECKSUM_GEN_UDP        1
#define CHECKSUM_GEN_TCP        1
#define CHECKSUM_CHECK_IP       1
#define CHECKSUM_CHECK_UDP      1
#define CHECKSUM_CHECK_TCP      1

/* Callbacks */
#define LWIP_NETIF_STATUS_CALLBACK 1

/* Disabled APIs (not available with NO_SYS) */
#define LWIP_NETCONN            0
#define LWIP_SOCKET             0
#define LWIP_STATS              0

#endif /* LWIPOPTS_H */
