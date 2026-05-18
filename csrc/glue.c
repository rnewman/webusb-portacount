#include "lwip/init.h"
#include "lwip/netif.h"
#include "lwip/etharp.h"
#include "netif/ethernet.h"
#include "lwip/timeouts.h"
#include "lwip/pbuf.h"
#include "lwip/autoip.h"
#include "lwip/dhcp.h"
#include "lwip/tcp.h"
#include "lwip/ip4_addr.h"
#include <emscripten.h>
#include <string.h>

static struct netif webusb_netif;

#define MAX_FRAME_SIZE 1600
#define MAX_SERVER_CONNS 8
static uint8_t output_frame_buf[MAX_FRAME_SIZE];
static uint8_t inject_frame_buf[MAX_FRAME_SIZE];
static uint8_t tcp_write_buf[MAX_FRAME_SIZE];
static uint8_t tcp_recv_buf[MAX_FRAME_SIZE];
static uint8_t server_write_buf[MAX_FRAME_SIZE];
static uint8_t server_recv_buf[MAX_FRAME_SIZE];

/* ---- JS callbacks via EM_JS ---- */

EM_JS(void, js_on_output_frame, (const uint8_t *data, int len), {
    if (Module._onOutputFrame) {
        Module._onOutputFrame(data, len);
    }
});

EM_JS(void, js_on_ip_status, (uint32_t ip), {
    if (Module._onIpStatus) {
        Module._onIpStatus(ip);
    }
});

EM_JS(void, js_on_tcp_connected, (void), {
    if (Module._onTcpConnected) {
        Module._onTcpConnected();
    }
});

EM_JS(void, js_on_tcp_recv, (const uint8_t *data, int len), {
    if (Module._onTcpRecv) {
        Module._onTcpRecv(data, len);
    }
});

EM_JS(void, js_on_tcp_closed, (void), {
    if (Module._onTcpClosed) {
        Module._onTcpClosed();
    }
});

EM_JS(void, js_on_tcp_error, (int err), {
    if (Module._onTcpError) {
        Module._onTcpError(err);
    }
});

EM_JS(void, js_on_server_accept, (int conn_id, int port), {
    if (Module._onServerAccept) {
        Module._onServerAccept(conn_id, port);
    }
});

EM_JS(void, js_on_server_recv, (int conn_id, const uint8_t *data, int len), {
    if (Module._onServerRecv) {
        Module._onServerRecv(conn_id, data, len);
    }
});

EM_JS(void, js_on_server_closed, (int conn_id), {
    if (Module._onServerClosed) {
        Module._onServerClosed(conn_id);
    }
});

/* ---- netif callbacks ---- */

static err_t webusb_linkoutput(struct netif *netif, struct pbuf *p) {
    if (p->tot_len > MAX_FRAME_SIZE) return ERR_BUF;
    int len = pbuf_copy_partial(p, output_frame_buf, p->tot_len, 0);
    js_on_output_frame(output_frame_buf, len);
    return ERR_OK;
}

static void netif_status_cb(struct netif *netif) {
    js_on_ip_status(netif_ip4_addr(netif)->addr);
}

static err_t webusb_netif_init(struct netif *netif) {
    netif->name[0] = 'u';
    netif->name[1] = 's';
    netif->linkoutput = webusb_linkoutput;
    netif->output = etharp_output;
    netif->mtu = 1500;
    netif->flags = NETIF_FLAG_BROADCAST | NETIF_FLAG_ETHARP |
                   NETIF_FLAG_ETHERNET | NETIF_FLAG_LINK_UP;
    netif->hwaddr_len = 6;
    netif->hwaddr[0] = 0x02;
    netif->hwaddr[1] = 0x00;
    netif->hwaddr[2] = 0x00;
    netif->hwaddr[3] = 0x00;
    netif->hwaddr[4] = 0x00;
    netif->hwaddr[5] = 0x01;
    return ERR_OK;
}

/* ---- Init ---- */

/* addressing: 0=static, 1=autoip, 2=dhcp */
EMSCRIPTEN_KEEPALIVE
int lwip_wasm_init(const uint8_t *mac, int mac_len,
                   int addressing,
                   int ip_a, int ip_b, int ip_c, int ip_d,
                   int nm_a, int nm_b, int nm_c, int nm_d) {
    lwip_init();

    ip4_addr_t ipaddr, netmask, gw;
    IP4_ADDR(&ipaddr,  0, 0, 0, 0);
    IP4_ADDR(&netmask, 0, 0, 0, 0);
    IP4_ADDR(&gw,      0, 0, 0, 0);

    netif_add(&webusb_netif, &ipaddr, &netmask, &gw,
              NULL, webusb_netif_init, ethernet_input);
    netif_set_default(&webusb_netif);
    netif_set_status_callback(&webusb_netif, netif_status_cb);

    if (mac && mac_len == 6) {
        memcpy(webusb_netif.hwaddr, mac, 6);
    }

    netif_set_up(&webusb_netif);

    switch (addressing) {
        case 0: /* static */
            IP4_ADDR(&ipaddr,  ip_a, ip_b, ip_c, ip_d);
            IP4_ADDR(&netmask, nm_a, nm_b, nm_c, nm_d);
            IP4_ADDR(&gw, 0, 0, 0, 0);
            netif_set_addr(&webusb_netif, &ipaddr, &netmask, &gw);
            break;
        case 1: /* autoip */
            autoip_start(&webusb_netif);
            break;
        case 2: /* dhcp */
            dhcp_start(&webusb_netif);
            break;
        default:
            return -1;
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
uint32_t lwip_wasm_get_ip(void) {
    return netif_ip4_addr(&webusb_netif)->addr;
}

EMSCRIPTEN_KEEPALIVE
uint32_t lwip_wasm_get_gateway(void) {
    return netif_ip4_gw(&webusb_netif)->addr;
}

EMSCRIPTEN_KEEPALIVE
uint32_t lwip_wasm_get_netmask(void) {
    return netif_ip4_netmask(&webusb_netif)->addr;
}

/* ---- Frame I/O ---- */

EMSCRIPTEN_KEEPALIVE
uint8_t *lwip_wasm_get_inject_buf(void) {
    return inject_frame_buf;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_inject_frame(int len) {
    if (len <= 0 || len > MAX_FRAME_SIZE) return -1;

    struct pbuf *p = pbuf_alloc(PBUF_RAW, len, PBUF_POOL);
    if (!p) return -1;

    pbuf_take(p, inject_frame_buf, len);
    if (webusb_netif.input(p, &webusb_netif) != ERR_OK) {
        pbuf_free(p);
        return -1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void lwip_wasm_check_timeouts(void) {
    sys_check_timeouts();
}

EMSCRIPTEN_KEEPALIVE
uint8_t *lwip_wasm_get_frame_buf(void) {
    return output_frame_buf;
}

/* ---- Echo server (test infrastructure) ---- */

static err_t echo_recv_cb(void *arg, struct tcp_pcb *tpcb, struct pbuf *p, err_t err) {
    if (p == NULL) {
        /* Connection closed by peer */
        tcp_close(tpcb);
        return ERR_OK;
    }
    /* Echo the data back */
    tcp_write(tpcb, p->payload, p->tot_len, TCP_WRITE_FLAG_COPY);
    tcp_output(tpcb);
    tcp_recved(tpcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static err_t echo_accept_cb(void *arg, struct tcp_pcb *newpcb, err_t err) {
    if (err != ERR_OK || newpcb == NULL) return ERR_VAL;
    tcp_recv(newpcb, echo_recv_cb);
    return ERR_OK;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_echo_server_start(int port) {
    struct tcp_pcb *pcb = tcp_new();
    if (!pcb) return -1;

    err_t err = tcp_bind(pcb, IP_ADDR_ANY, (u16_t)port);
    if (err != ERR_OK) {
        tcp_abort(pcb);
        return -1;
    }

    struct tcp_pcb *lpcb = tcp_listen(pcb);
    if (!lpcb) {
        tcp_abort(pcb);
        return -1;
    }
    /* Note: tcp_listen frees original pcb and returns a new listen pcb */

    tcp_accept(lpcb, echo_accept_cb);
    return 0;
}

/* ---- TCP client API ---- */

static struct tcp_pcb *client_pcb = NULL;

static err_t client_recv_cb(void *arg, struct tcp_pcb *tpcb, struct pbuf *p, err_t err) {
    if (p == NULL) {
        /* Peer closed connection */
        js_on_tcp_closed();
        client_pcb = NULL;
        return ERR_OK;
    }

    /* Copy received data to shared buffer and notify JS */
    u16_t copy_len = p->tot_len;
    if (copy_len > MAX_FRAME_SIZE) copy_len = MAX_FRAME_SIZE;
    pbuf_copy_partial(p, tcp_recv_buf, copy_len, 0);
    js_on_tcp_recv(tcp_recv_buf, copy_len);

    tcp_recved(tpcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static void client_err_cb(void *arg, err_t err) {
    client_pcb = NULL;
    js_on_tcp_error((int)err);
}

static err_t client_connected_cb(void *arg, struct tcp_pcb *tpcb, err_t err) {
    if (err != ERR_OK) {
        js_on_tcp_error((int)err);
        return err;
    }
    js_on_tcp_connected();
    return ERR_OK;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_tcp_connect(int ip_a, int ip_b, int ip_c, int ip_d, int port) {
    if (client_pcb) {
        tcp_abort(client_pcb);
        client_pcb = NULL;
    }

    client_pcb = tcp_new();
    if (!client_pcb) return -1;

    ip_addr_t addr;
    IP4_ADDR(ip_2_ip4(&addr), ip_a, ip_b, ip_c, ip_d);
    IP_SET_TYPE(&addr, IPADDR_TYPE_V4);

    tcp_recv(client_pcb, client_recv_cb);
    tcp_err(client_pcb, client_err_cb);

    err_t err = tcp_connect(client_pcb, &addr, (u16_t)port, client_connected_cb);
    if (err != ERR_OK) {
        tcp_abort(client_pcb);
        client_pcb = NULL;
        return -1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *lwip_wasm_get_tcp_write_buf(void) {
    return tcp_write_buf;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_tcp_write(int len) {
    if (!client_pcb) return -1;
    if (len <= 0 || len > MAX_FRAME_SIZE) return -1;

    err_t err = tcp_write(client_pcb, tcp_write_buf, (u16_t)len, TCP_WRITE_FLAG_COPY);
    if (err != ERR_OK) return (int)err;

    tcp_output(client_pcb);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_tcp_close(void) {
    if (!client_pcb) return -1;
    tcp_close(client_pcb);
    client_pcb = NULL;
    return 0;
}

/* ---- Generic JS-controlled TCP server ----
 *
 * The C side owns the listen PCB and the accept loop; each accepted PCB
 * gets a small integer conn_id that JS uses to write back or close. All
 * inbound data is delivered to JS via _onServerRecv. This lets us build
 * test fakes (e.g. a mock Portacount on ports 3602/3603) in TS without
 * baking protocol responses into C.
 */

static struct tcp_pcb *server_pcbs[MAX_SERVER_CONNS] = {0};

static int server_alloc_conn(struct tcp_pcb *pcb) {
    for (int i = 0; i < MAX_SERVER_CONNS; i++) {
        if (server_pcbs[i] == NULL) {
            server_pcbs[i] = pcb;
            return i;
        }
    }
    return -1;
}

static err_t server_recv_cb(void *arg, struct tcp_pcb *tpcb, struct pbuf *p, err_t err) {
    int conn_id = (int)(intptr_t)arg;

    if (p == NULL) {
        /* Peer closed. */
        if (conn_id >= 0 && conn_id < MAX_SERVER_CONNS) {
            server_pcbs[conn_id] = NULL;
        }
        js_on_server_closed(conn_id);
        tcp_close(tpcb);
        return ERR_OK;
    }

    /* Ack the bytes and free the pbuf BEFORE the JS callback. JS may
     * synchronously call tcp_close (via lwip_wasm_server_close), and
     * lwIP must not see a tcp_recved on a pcb that's already entering
     * close. */
    u16_t pkt_len = p->tot_len;
    u16_t copy_len = pkt_len;
    if (copy_len > MAX_FRAME_SIZE) copy_len = MAX_FRAME_SIZE;
    pbuf_copy_partial(p, server_recv_buf, copy_len, 0);
    tcp_recved(tpcb, pkt_len);
    pbuf_free(p);

    js_on_server_recv(conn_id, server_recv_buf, copy_len);
    return ERR_OK;
}

static err_t server_accept_cb(void *arg, struct tcp_pcb *newpcb, err_t err) {
    if (err != ERR_OK || newpcb == NULL) return ERR_VAL;

    int conn_id = server_alloc_conn(newpcb);
    if (conn_id < 0) {
        /* No free slot. */
        tcp_abort(newpcb);
        return ERR_ABRT;
    }

    tcp_arg(newpcb, (void *)(intptr_t)conn_id);
    tcp_recv(newpcb, server_recv_cb);

    js_on_server_accept(conn_id, (int)newpcb->local_port);
    return ERR_OK;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_server_listen(int port) {
    struct tcp_pcb *pcb = tcp_new();
    if (!pcb) return -1;

    err_t err = tcp_bind(pcb, IP_ADDR_ANY, (u16_t)port);
    if (err != ERR_OK) {
        tcp_abort(pcb);
        return -1;
    }

    struct tcp_pcb *lpcb = tcp_listen(pcb);
    if (!lpcb) {
        tcp_abort(pcb);
        return -1;
    }

    tcp_accept(lpcb, server_accept_cb);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *lwip_wasm_get_server_write_buf(void) {
    return server_write_buf;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_server_write(int conn_id, int len) {
    if (conn_id < 0 || conn_id >= MAX_SERVER_CONNS) return -1;
    if (len <= 0 || len > MAX_FRAME_SIZE) return -1;
    struct tcp_pcb *pcb = server_pcbs[conn_id];
    if (!pcb) return -1;

    err_t err = tcp_write(pcb, server_write_buf, (u16_t)len, TCP_WRITE_FLAG_COPY);
    if (err != ERR_OK) return (int)err;

    tcp_output(pcb);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int lwip_wasm_server_close(int conn_id) {
    if (conn_id < 0 || conn_id >= MAX_SERVER_CONNS) return -1;
    struct tcp_pcb *pcb = server_pcbs[conn_id];
    if (!pcb) return -1;
    server_pcbs[conn_id] = NULL;
    tcp_close(pcb);
    return 0;
}
