#!/bin/sh
# Usage: router-start.sh <wan-prefix> <lan-prefix> <upnp: yes|no>
# Turns this container into a home router (nftables): NAT from the LAN to the
# "internet" side, and, with upnp=yes, miniupnpd so LAN devices can open ports
# automatically (UPnP IGD), the way most home routers do.
set -e
WAN_PREFIX="$1"; LAN_PREFIX="$2"; UPNP="$3"
iface_for() { ip -o -4 addr show | awk -v p="$1" 'index($4, p) == 1 { print $2; exit }'; }
WAN_IF=$(iface_for "$WAN_PREFIX"); LAN_IF=$(iface_for "$LAN_PREFIX")
echo "wan=$WAN_IF lan=$LAN_IF"
# Tables and chains miniupnpd expects (table inet filter: forward -> miniupnpd,
# prerouting -> prerouting_miniupnpd, postrouting -> postrouting_miniupnpd).
/etc/miniupnpd/nft_init.sh
nft add rule inet filter forward iifname "$LAN_IF" oifname "$WAN_IF" accept
nft add rule inet filter forward ct state established,related accept
nft add rule inet filter postrouting oifname "$WAN_IF" masquerade
if [ "$UPNP" = "yes" ]; then
  cat > /tmp/miniupnpd.conf <<CONF
ext_ifname=$WAN_IF
listening_ip=$LAN_IF
port=5000
enable_natpmp=no
enable_upnp=yes
secure_mode=yes
system_uptime=yes
upnp_table_name=filter
upnp_nat_table_name=filter
upnp_forward_chain=miniupnpd
upnp_nat_chain=prerouting_miniupnpd
upnp_nat_postrouting_chain=postrouting_miniupnpd
uuid=3f2a1b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c
allow 1024-65535 ${LAN_PREFIX}0/24 1024-65535
deny 0-65535 0.0.0.0/0 0-65535
CONF
  miniupnpd -f /tmp/miniupnpd.conf -d > /tmp/miniupnpd.log 2>&1 &
fi
echo router-ready
exec sleep infinity
