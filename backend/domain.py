"""领域核心层：CIDR 计算、地址状态机、分配锁。

设计说明（对应架构图 03 层）：
- 可用地址不预生成数据行。大网段的占用状态由「前缀记录 + 已落库地址集合」推导，
  避免 10.0.0.0/8 这类地址段产生千万级空行。分配时按需插入一条记录。
- 生产替换点 1：包含 / 重叠判定此处用 ipaddress + 整数区间；PostgreSQL 可换
  inet/cidr 类型 + GiST 索引，接口语义不变。
- 生产替换点 2：分配锁此处用进程内 per-prefix 锁 + SQLite BEGIN IMMEDIATE；
  多实例部署时换成 Redis 分布式锁。
"""
from __future__ import annotations

import ipaddress
import threading
from contextlib import contextmanager
from typing import Iterable

# 已登记占用的状态。available 不落库。
OCCUPYING_STATUSES = ("assigned", "reserved", "deprecated", "conflict")

STATUS_LABELS = {
    "assigned": "已分配",
    "reserved": "预留",
    "deprecated": "待回收",
    "conflict": "冲突",
    "available": "可用",
}

# 状态机：任何入口的写操作都必须经过这里，不允许直接改状态字段
TRANSITIONS: dict[str, set[str]] = {
    "reserved": {"assigned", "conflict"},   # 确认预留 / 对账标记冲突
    "assigned": {"deprecated", "conflict"}, # 发起回收 / 对账标记冲突
    "deprecated": {"available"},            # 释放校验通过，归还可用池
    "conflict": {"assigned", "deprecated"}, # 冲突处理完成 / 直接下线
}


def net(cidr: str) -> ipaddress.IPv4Network:
    return ipaddress.ip_network(cidr, strict=True)


def to_int(addr: str) -> int:
    return int(ipaddress.ip_address(addr))


def to_ip(value: int) -> str:
    return str(ipaddress.ip_address(value))


def parse_ipv4(addr: str) -> int:
    """严格解析单台主机 IPv4 地址：拒绝掩码、IPv6、前导零与非法点分十进制。

    手动分配入口专用，避免把 10.1.1.0/24、::1 之类的字符串写进地址池。
    """
    text = (addr or "").strip()
    if not text:
        raise ValueError("请输入要分配的 IPv4 地址")
    if "/" in text:
        raise ValueError("请输入单个 IP 地址，不要带掩码（子网请在目标子网中选择）")
    try:
        return int(ipaddress.IPv4Address(text))
    except (ipaddress.AddressValueError, ValueError) as exc:
        raise ValueError(f"无效的 IPv4 地址：{text}") from exc


def parse_network_text(text: str) -> ipaddress.IPv4Network | None:
    """宽松解析搜索框里的 CIDR（允许主机位），非法或非 IPv4 输入返回 None。

    只用于只读检索，不参与写操作；写路径仍走严格的 parse_cidr / net。
    """
    try:
        n = ipaddress.ip_network((text or "").strip(), strict=False)
    except ValueError:
        return None
    return n if isinstance(n, ipaddress.IPv4Network) else None


def bounds(cidr: str) -> tuple[int, int, int]:
    n = net(cidr)
    return int(n.network_address), int(n.broadcast_address), n.num_addresses


def retained(cidr: str) -> set[int]:
    """网络号、默认网关、广播地址不参与分配。"""
    start, end, _ = bounds(cidr)
    return {start, start + 1, end}


def contains(parent: str, child: str) -> bool:
    p, c = net(parent), net(child)
    return c.subnet_of(p) and p.prefixlen < c.prefixlen


def overlaps(a: str, b: str) -> bool:
    return net(a).overlaps(net(b))


def next_available(cidr: str, occupied: Iterable[int]) -> int | None:
    """返回该前缀内最小的可分配地址；无可用地址返回 None。

    /24 规模的线性扫描足够（最多 254 次）。生产环境对超网应改用
    空闲区间表（free ranges）或位图，避免扫描大地址段。
    """
    start, end, _ = bounds(cidr)
    blocked = set(occupied) | retained(cidr)
    for value in range(start + 2, end):
        if value not in blocked:
            return value
    return None


def cidr_info(cidr: str) -> dict:
    """子网划分所需的全部 CIDR 派生信息。生产环境可替换为 inet/cidr + GiST。

    首 / 末可分配地址用整数推导，不再 list(n.hosts())：对 10.0.0.0/8 这类
    大网段做纯计算时不会再生成千万级地址对象。
    """
    n = net(cidr)
    start, end, total = int(n.network_address), int(n.broadcast_address), n.num_addresses
    if total == 1:                 # /32：hosts() 只有自身
        first = last = start
    elif total == 2:               # /31：hosts() = [network, broadcast]，无广播保留
        first = last = start + 1
    else:                          # 其余：跳过网络号与网关，末个为广播前一位
        first, last = start + 2, end - 1
    return {
        "cidr": str(n),
        "prefixlen": n.prefixlen,
        "mask": str(n.netmask),
        "wildcard": str(n.hostmask),
        "network": str(n.network_address),
        "broadcast": str(n.broadcast_address),
        "first_host": to_ip(first),
        "last_host": to_ip(last),
        "total": total,
        "usable": max(0, total - 3),
    }


def subnet_grid(cidr: str, new_prefix: int) -> tuple[int, int, int]:
    """等分参数 (父网络起始整数, 每段地址数, 子网总数)，不枚举任何子网。"""
    parent = net(cidr)
    if new_prefix <= parent.prefixlen or new_prefix > 32:
        raise ValueError("目标掩码必须大于父前缀且不超过 /32")
    return (int(parent.network_address), 1 << (32 - new_prefix),
            1 << (new_prefix - parent.prefixlen))


def subnets_of(cidr: str, new_prefix: int, offset: int = 0,
               limit: int | None = 64) -> list[str]:
    """按整数索引取 [offset, offset+limit) 的等分子网，开销 O(limit)。

    limit=None 表示取到末尾；默认值 64 仅兼容旧调用，规划接口会显式传分页参数。
    """
    base, size, total = subnet_grid(cidr, new_prefix)
    start = max(0, int(offset))
    stop = total if limit is None else min(total, start + max(0, int(limit)))
    return [f"{to_ip(base + i * size)}/{new_prefix}" for i in range(start, stop)]


def parse_prefix_ranges(existing: Iterable[str]) -> list[tuple[int, int, int, str]]:
    """把已有前缀预解析为 (起, 止, 掩码长度, CIDR)，供批量冲突校验复用。"""
    out = []
    for e in existing:
        n = net(e)
        out.append((int(n.network_address), int(n.broadcast_address),
                    n.prefixlen, str(n)))
    return out


def conflicts_in_range(start: int, end: int, prefixlen: int,
                       ranges: list[tuple[int, int, int, str]]) -> list[str]:
    """与 plan_conflicts 等价的批量版本：更粗的祖先前缀（对齐包含）不算冲突。"""
    bad = []
    for e0, e1, eplen, ecidr in ranges:
        if eplen < prefixlen and e0 <= start and end <= e1:
            continue
        if e0 <= end and start <= e1:
            bad.append(ecidr)
    return bad


def plan_conflicts(cidr: str, existing: Iterable[str]) -> list[str]:
    """03 层重叠校验：祖先前缀（正常包含关系）不算冲突。

    真正的冲突是：同网段重复登记、候选网段内已有更细的划分、或 CIDR 部分交叠。
    """
    target = net(cidr)
    bad = []
    for e in existing:
        n = net(e)
        if target.subnet_of(n) and n.prefixlen < target.prefixlen:
            continue
        if n.overlaps(target):
            bad.append(e)
    return bad


def can_transition(src: str, dst: str) -> bool:
    return dst in TRANSITIONS.get(src, set())


_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


@contextmanager
def prefix_lock(vrf: str, cidr: str):
    """同一 (VRF, 前缀) 的分配操作串行化，防止并发申请拿到同一个地址。

    真隔离下同一 CIDR 可存在于多个地址平面，锁键必须带上 vrf：
    既要让同平面同网段互斥，又不能让不同平面的相同网段互相阻塞。
    """
    key = f"{vrf or 'default'}|{cidr}"
    with _guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        yield
