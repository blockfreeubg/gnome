# Benchmark results: 2026-11-24-quick-dev-smoke

Preset **quick** — dev smoke, shared machine: other agents were building and testing at the same time; not final numbers. 2026-11-24T20:16:52.688Z → 2026-11-24T20:46:31.122Z.

Machine: AMD Ryzen 5 5600G with Radeon Graphics, 12 logical CPUs (6 cores), governor performance, kernel 7.3.1-1-cachyos, 15350 MiB RAM; rustc 1.99.1 (58cf8f9c3 2026-10-13) (Arch Linux rust 1:1.99.1-1); Node v26.13.0; wisp-js 0.5.3. CPU sets: servers 0,1,2,3, idle siblings 6,7,8,9, load generator 4,5,10,11.

Server: `<scratch>/bin/gnome-server-b1` (sha256 a1371bc3d49ab858…), snapshot baseline-1 = git 900a6ff (tree sha 0b602bb8e218cee4); dist: plain build + harness siblings.

Equivalence check: pass (51/51; 64 MiB echo rust equal, node1 equal).

Marks: **N** noisy (the quiet gate failed and no clean repeat exists), **L** load-generator-bound, **X** loopback limits hit (not a server number).

## W1

| variant | config | MiB/s | peak RSS MiB | n | marks |
| --- | --- | ---: | --- | ---: | --- |
| 1x1 | rust | 1,335.7 | gnome-server 54.1, holywisp 2 | 1 | NX |
| 1x10 | rust | 1,487 | gnome-server 54.1, holywisp 2.1 | 2 | N RB5 |
| 8x4 | rust | 2,960.8 | gnome-server 54.1, holywisp 5 | 1 | N |
| 64x4 | rust | 3,020.7 | gnome-server 54.1, holywisp 28.3 | 1 | N |
| 768x1 | rust | 1,787.6 | gnome-server 56.9, holywisp 280.7 | 1 | N |
| 1x1 | node1 | 588.7 | node-gateway 153.6, holywisp 0.9 | 1 | N |
| 1x10 | node1 | 946.9 | node-gateway 162.2, holywisp 0.9 | 1 | N |
| 8x4 | node1 | 800.5 | node-gateway 186.1, holywisp 7.1 | 1 | N |
| 64x4 | node1 | 1,024.6 | node-gateway 215.6, holywisp 17.3 | 1 | N |
| 768x1 | node1 | 796 | node-gateway 227.1, holywisp 83.6 | 1 | NX |
| 1x1 | node4 | 787 | node-gateway 721.1, holywisp 2 | 1 | N |
| 1x10 | node4 | 1,418.6 | node-gateway 729.9, holywisp 2.1 | 1 | N |
| 8x4 | node4 | 1,736 | node-gateway 743.1, holywisp 6.1 | 1 | N |
| 64x4 | node4 | 1,191 | node-gateway 753.1, holywisp 38.8 | 1 | N |
| 768x1 | node4 | 1,050.8 | node-gateway 779.5, holywisp 251.6 | 1 | N |
| 1x1 | node4-wispjs | 466.8 | node-gateway 479.2, wispjs 466.1 | 1 | N |
| 1x10 | node4-wispjs | 479.7 | node-gateway 534.2, wispjs 549.9 | 1 | N |
| 8x4 | node4-wispjs | 754.9 | node-gateway 710.4, wispjs 814.8 | 1 | N |
| 64x4 | node4-wispjs | 703.8 | node-gateway 717.8, wispjs 820.5 | 1 | N |
| 768x1 | node4-wispjs | 590.4 | node-gateway 753.9, wispjs 843 | 1 | N |
| 1x1 | holywisp | 1,231.9 | holywisp 1.9 | 1 | N |
| 1x10 | holywisp | 1,879.8 | holywisp 2 | 2 | N RB5 |
| 8x4 | holywisp | 2,606.2 | holywisp 4.2 | 1 | N |
| 64x4 | holywisp | 2,953.4 | holywisp 26.7 | 1 | N |
| 768x1 | holywisp | 2,292.7 | holywisp 200.5 | 1 | N |
| 1x1 | wispjs | 760.6 | wispjs 260.2 | 1 | N |
| 1x10 | wispjs | 739.5 | wispjs 190.4 | 1 | N |
| 8x4 | wispjs | 698.1 | wispjs 326.2 | 1 | N |
| 64x4 | wispjs | 641.2 | wispjs 283.8 | 1 | N |
| 768x1 | wispjs | 681.3 | wispjs 267.2 | 1 | NX |
| 1x1 | wispjs4 | 738.1 | wispjs 439.3 | 1 | N |
| 1x10 | wispjs4 | 687.5 | wispjs 525.8 | 1 | N |
| 8x4 | wispjs4 | 1,393.1 | wispjs 812.9 | 1 | N |
| 64x4 | wispjs4 | 1,051.4 | wispjs 828.5 | 1 | N |
| 768x1 | wispjs4 | 1,030.9 | wispjs 825 | 1 | N |

## W2

| variant | config | ops/s | p50 µs | p99 µs | p99.9 µs | max µs | peak RSS MiB | n | marks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| idle | rust | 12,849.9 | 71.7 | 147.5 | 737.3 | 6,160.4 | gnome-server 56.4, holywisp 1.8 | 2 | N RB6 |
| under W1 8x4 | rust | 523.1 | 1,703.9 | 5,242.9 | 6,946.8 | 8,650.8 | gnome-server 56.4, holywisp 4 | 1 | N |
| idle | node1 | 11,708.1 | 77.8 | 167.9 | 868.4 | 6,291.5 | node-gateway 217.9, holywisp 0.9 | 1 | N |
| under W1 8x4 | node1 | 122.9 | 7,602.2 | 15,990.8 | 20,447.2 | 20,447.2 | node-gateway 214.9, holywisp 5.3 | 1 | N |
| idle | node4 | 9,875.1 | 88.1 | 311.3 | 1,900.5 | 16,777.2 | node-gateway 764.5, holywisp 1.8 | 1 | N |
| under W1 8x4 | node4 | 167.7 | 5,111.8 | 20,971.5 | 30,933 | 32,505.9 | node-gateway 728.7, holywisp 7.1 | 1 | N |
| idle | node4-wispjs | 6,429.5 | 129 | 737.3 | 3,342.3 | 20,447.2 | node-gateway 712, wispjs 857.3 | 1 | N |
| under W1 8x4 | node4-wispjs | 20.8 | 44,040.2 | 102,760.4 | 142,606.3 | 142,606.3 | node-gateway 734.1, wispjs 872 | 1 | N |
| idle | holywisp | 26,713.5 | 33.8 | 59.4 | 491.5 | 2,654.2 | holywisp 1.8 | 2 | N RB6 |
| under W1 8x4 | holywisp | 1,357.1 | 262.1 | 4,849.7 | 7,209 | 12,582.9 | holywisp 4.4 | 1 | N |
| idle | wispjs | 19,884.5 | 47.1 | 81.9 | 294.9 | 1,638.4 | wispjs 224.1 | 1 | N |
| under W1 8x4 | wispjs | 15.1 | 66,060.3 | 85,983.2 | 92,274.7 | 92,274.7 | wispjs 347.4 | 1 | N |
| idle | wispjs4 | 4,086.2 | 79.9 | 2,359.3 | 22,544.4 | 176,160.8 | wispjs 863 | 1 | N |
| under W1 8x4 | wispjs4 | 19.4 | 52,428.8 | 104,857.6 | 106,954.8 | 106,954.8 | wispjs 918.2 | 1 | N |

## W3

| variant | config | ops/s | p50 µs | p99 µs | p99.9 µs | max µs | peak RSS MiB | n | marks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| (a) setup churn | rust | 5,045 | 5,636.1 | 15,990.8 | 22,020.1 | 32,505.9 | gnome-server 56.5, holywisp 2.1 | 2 | NX RB7 |
| (a) setup churn | node1 | 1,806.1 | 16,777.2 | 28,311.6 | 54,526 | 69,206 | node-gateway 253.6, holywisp 1 | 1 | N |
| (a) setup churn | node4 | 3,042.3 | 9,699.3 | 23,593 | 33,554.4 | 51,380.2 | node-gateway 948.8, holywisp 2.1 | 1 | N |
| (a) setup churn | node4-wispjs | 1,852.6 | 15,466.5 | 41,943 | 167,772.2 | 184,549.4 | node-gateway 845.9, wispjs 1032.2 | 1 | N |
| (a) setup churn | holywisp | 7,816.4 | 2,490.4 | 17,825.8 | 25,690.1 | 38,797.3 | holywisp 2.2 | 1 | N |
| (b) stream churn | holywisp | 20,822.4 | 335.9 | 1,081.3 | 2,097.2 | 4,849.7 | holywisp 1.9 | 1 | N |
| (a) setup churn | wispjs | 3,638.4 | 8,388.6 | 12,058.6 | 17,825.8 | 19,398.7 | wispjs 249.1 | 1 | N |
| (b) stream churn | wispjs | 8,340.7 | 933.9 | 1,278 | 1,703.9 | 2,752.5 | wispjs 240.5 | 1 | N |
| (a) setup churn | wispjs4 | 4,669.5 | 6,160.4 | 16,777.2 | 27,263 | 51,380.2 | wispjs 1132.2 | 1 | N |
| (b) stream churn | wispjs4 | 13,326.1 | 524.3 | 1,835 | 2,949.1 | 6,553.6 | wispjs 1087 | 1 | N |

## W4

| variant | config | KiB/conn gnome-server | KiB/conn holywisp | KiB/conn node-gateway | KiB/conn wispjs | peak RSS MiB | n | marks |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| N=1000 | rust | 10.7 | 13.6 |  |  | gnome-server 33.3, holywisp 67 | 2 | N RB3 |
| N=3000 | rust | 7 | 13.6 |  |  | gnome-server 54.1, holywisp 94.6 | 2 | N RB3 |
| N=1000 | node4 |  | 13.6 | 25.7 |  | node-gateway 576.9, holywisp 29.4 | 1 | N |
| N=3000 | node4 |  | 13.6 | 12.6 |  | node-gateway 741.3, holywisp 56.7 | 1 | N |
| N=1000 | holywisp |  | 13.6 |  |  | holywisp 29.4 | 1 | N |
| N=3000 | holywisp |  | 13.6 |  |  | holywisp 56.5 | 1 | N |
| N=1000 | wispjs |  |  |  | 50.7 | wispjs 215.9 | 1 | N |
| N=3000 | wispjs |  |  |  | 18.7 | wispjs 293.1 | 1 | N |
| slope N=1000→N=3000 | rust | 10.5 | 14.1 |  |  |  | 2 |  RB3 |
| slope N=1000→N=3000 | node4 |  | 14.3 | 97.2 |  |  | 1 |  |
| slope N=1000→N=3000 | holywisp |  | 14 |  |  |  | 1 |  |
| slope N=1000→N=3000 | wispjs |  |  |  | 74.2 |  | 1 |  |

## H1

| variant | config | req/s | p50 µs | p99 µs | p99.9 µs | CPU µs/req | peak RSS MiB | n | marks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| (a) c=64 | rust | 94,526.4 | 622.6 | 1,867.8 | 4,456.4 | 43.5 | gnome-server 56.5, holywisp 1.8 | 2 | NX RB8 |
| (a) 5000/s | rust | 4,999.8 | 84 | 475.1 | 2,752.5 | 59.4 | gnome-server 56.5, holywisp 1.8 | 2 | N RB8 |
| (b) c=64 | rust | 84,093.3 | 737.3 | 1,540.1 | 2,359.3 | 47.1 | gnome-server 56.5, holywisp 1.8 | 1 | N |
| (b) 5000/s | rust | 4,999.8 | 67.6 | 116.7 | 516.1 | 44.4 | gnome-server 56.5, holywisp 1.8 | 1 | N |
| (c) c=64 | rust | 49,373.6 | 1,245.2 | 2,818 | 4,063.2 | 80.7 | gnome-server 56.5, holywisp 1.8 | 1 | N |
| (c) 5000/s | rust | 4,999.9 | 77.8 | 139.3 | 483.3 | 64.4 | gnome-server 56.5, holywisp 1.8 | 1 | N |
| (d) c=64 | rust | 171,938.8 | 352.3 | 852 | 1,278 | 21.5 | gnome-server 56.5, holywisp 1.8 | 1 | N |
| (d) 5000/s | rust | 4,999.9 | 48.1 | 100.4 | 1,146.9 | 35.2 | gnome-server 56.5, holywisp 1.8 | 1 | N |
| (e) c=64 | rust | 4,223.6 | 14,680.1 | 23,068.7 | 26,738.7 | 968.9 | gnome-server 62.4, holywisp 1.8 | 1 | N |
| (e) 5000/s | rust | 3,595.4 | 1,677,721.6 | 2,684,354.6 | 2,751,463.4 | 1,109.5 | gnome-server 62.7, holywisp 1.8 | 1 | N |
| (f) c=64 | rust | 141,384.4 | 417.8 | 1,245.2 | 2,883.6 | 26.9 | gnome-server 60.9, holywisp 1.8 | 1 | N |
| (f) 5000/s | rust | 4,999.8 | 55.3 | 92.2 | 172 | 35.7 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| (g) c=64 | rust | 177,691.1 | 344.1 | 852 | 1,310.7 | 20.6 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| (g) 5000/s | rust | 4,999.8 | 47.1 | 86 | 188.4 | 32.7 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| (a) c=64 | node1 | 15,513.7 | 4,063.2 | 5,767.2 | 8,912.9 | 71.2 | node-gateway 263.2, holywisp 0.8 | 1 | N |
| (a) 5000/s | node1 | 4,998.9 | 884.7 | 8,257.5 | 15,466.5 | 112.7 | node-gateway 263.2, holywisp 0.8 | 1 | N |
| (b) c=64 | node1 | 21,459.2 | 2,818 | 5,505 | 6,291.5 | 50.2 | node-gateway 263.2, holywisp 0.8 | 1 | N |
| (b) 5000/s | node1 | 4,999.8 | 112.6 | 606.2 | 2,621.4 | 100.6 | node-gateway 260.8, holywisp 0.8 | 1 | N |
| (c) c=64 | node1 | 11,628.3 | 5,111.8 | 8,257.5 | 10,485.8 | 91.1 | node-gateway 260.1, holywisp 0.8 | 1 | N |
| (c) 5000/s | node1 | 4,999.9 | 112.6 | 589.8 | 2,621.4 | 113.9 | node-gateway 259.8, holywisp 0.8 | 1 | N |
| (d) c=64 | node1 | 26,051.7 | 2,228.2 | 4,194.3 | 6,029.3 | 41.4 | node-gateway 260.4, holywisp 0.8 | 1 | N |
| (d) 5000/s | node1 | 4,999.9 | 75.8 | 106.5 | 524.3 | 78.4 | node-gateway 260.4, holywisp 0.8 | 1 | N |
| (e) c=64 | node1 | 1,594.3 | 38,797.3 | 53,477.4 | 67,108.9 | 1,495 | node-gateway 260, holywisp 0.8 | 1 | N |
| (e) 5000/s | node1 | 1,420.5 | 3,422,552.1 | 6,979,321.9 | 6,979,321.9 | 1,464.4 | node-gateway 254.4, holywisp 0.8 | 1 | N |
| (f) c=64 | node1 | 14,736.9 | 4,456.4 | 6,291.5 | 11,272.2 | 74.1 | node-gateway 261.8, holywisp 0.8 | 1 | N |
| (f) 5000/s | node1 | 4,999.7 | 116.7 | 2,097.2 | 20,447.2 | 100.1 | node-gateway 262.5, holywisp 0.8 | 1 | N |
| (g) c=64 | node1 | 15,693.5 | 4,194.3 | 5,898.2 | 8,912.9 | 69.1 | node-gateway 264.3, holywisp 0.8 | 1 | N |
| (g) 5000/s | node1 | 4,999.9 | 116.7 | 2,293.8 | 4,194.3 | 99.9 | node-gateway 259.9, holywisp 0.8 | 1 | N |
| (a) c=64 | node4 | 69,501.9 | 770 | 3,604.5 | 9,175 | 59.2 | node-gateway 975.1, holywisp 1.8 | 2 | N RB8 |
| (a) 5000/s | node4 | 4,999.6 | 139.3 | 475.1 | 1,769.5 | 153.9 | node-gateway 975.7, holywisp 1.8 | 1 | N |
| (b) c=64 | node4 | 58,669.5 | 933.9 | 3,670 | 7,733.2 | 68 | node-gateway 986.1, holywisp 1.8 | 1 | N |
| (b) 5000/s | node4 | 4,999 | 167.9 | 4,456.4 | 32,505.9 | 174.9 | node-gateway 984.4, holywisp 1.8 | 1 | N |
| (c) c=64 | node4 | 21,343.2 | 1,835 | 18,874.4 | 39,845.9 | 124 | node-gateway 984.7, holywisp 1.8 | 1 | N |
| (c) 5000/s | node4 | 4,990.3 | 278.5 | 4,718.6 | 15,728.6 | 258.7 | node-gateway 981.4, holywisp 1.8 | 1 | N |
| (d) c=64 | node4 | 59,254.8 | 639 | 7,340 | 20,447.2 | 49.1 | node-gateway 987.7, holywisp 1.8 | 1 | N |
| (d) 5000/s | node4 | 4,998.6 | 155.6 | 3,342.3 | 13,369.3 | 168.6 | node-gateway 988.3, holywisp 1.8 | 1 | N |
| (e) c=64 | node4 | 1,748 | 31,981.6 | 111,149.1 | 142,606.3 | 2,414.4 | node-gateway 998.8, holywisp 1.8 | 1 | N |
| (e) 5000/s | node4 | 1,754.6 | 3,825,205.2 | 6,576,668.7 | 6,710,886.4 | 2,425.7 | node-gateway 978.9, holywisp 1.8 | 1 | N |
| (f) c=64 | node4 | 71,045.8 | 753.7 | 3,604.5 | 9,437.2 | 55.5 | node-gateway 899.1, holywisp 1.8 | 1 | N |
| (f) 5000/s | node4 | 4,999.7 | 143.4 | 933.9 | 3,342.3 | 160.3 | node-gateway 899.7, holywisp 1.8 | 1 | N |
| (g) c=64 | node4 | 79,478.1 | 671.7 | 3,014.7 | 9,175 | 51 | node-gateway 947.4, holywisp 1.8 | 1 | N |
| (g) 5000/s | node4 | 4,999.7 | 122.9 | 385 | 917.5 | 145.1 | node-gateway 943.2, holywisp 1.8 | 1 | N |

## A1

| variant | config | req/s | p50 µs | p99 µs | p99.9 µs | CPU µs/req | peak RSS MiB | n | marks |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| ticket c=64 | rust | 135,733.8 | 450.6 | 1,015.8 | 1,933.3 | 28.1 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| ticket 2000/s | rust | 1,999.9 | 81.9 | 233.5 | 1,081.3 | 62.9 | gnome-server 58.4, holywisp 1.8 | 2 | N RB9 |
| config c=64 | rust | 97,499.1 | 524.3 | 2,687 | 5,767.2 | 29 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| config 2000/s | rust | 2,000 | 75.8 | 1,998.8 | 4,980.7 | 55.4 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| session c=64 | rust | 20,548.3 | 1,966.1 | 20,447.2 | 61,866 | 42.4 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| session 2000/s | rust | 2,000.1 | 98.3 | 2,490.4 | 7,471.1 | 74.2 | gnome-server 58.4, holywisp 1.8 | 1 | N |
| ticket c=64 | node1 | 7,926.9 | 7,209 | 26,738.7 | 46,137.3 | 134.9 | node-gateway 266.7, holywisp 0.8 | 1 | N |
| ticket 2000/s | node1 | 2,000.2 | 139.3 | 1,507.3 | 3,670 | 165.2 | node-gateway 267.3, holywisp 0.8 | 1 | N |
| config c=64 | node1 | 22,355.7 | 2,555.9 | 4,456.4 | 6,291.5 | 48.1 | node-gateway 269.8, holywisp 0.8 | 1 | N |
| config 2000/s | node1 | 2,000 | 92.2 | 368.6 | 1,671.2 | 90.9 | node-gateway 267.3, holywisp 0.8 | 1 | N |
| session c=64 | node1 | 14,912.1 | 3,997.7 | 6,684.7 | 7,995.4 | 75 | node-gateway 268.2, holywisp 0.8 | 1 | N |
| session 2000/s | node1 | 2,000 | 108.5 | 622.6 | 2,359.3 | 112.1 | node-gateway 268.8, holywisp 0.8 | 1 | N |
| ticket c=64 | node4 | 39,551.7 | 1,441.8 | 4,980.7 | 12,582.9 | 109.2 | node-gateway 945.9, holywisp 1.8 | 1 | N |
| ticket 2000/s | node4 | 1,999.9 | 335.9 | 950.3 | 3,670 | 409.1 | node-gateway 938.8, holywisp 1.8 | 1 | N |
| config c=64 | node4 | 84,686 | 540.7 | 4,194.3 | 12,320.8 | 42.4 | node-gateway 966.2, holywisp 1.8 | 1 | N |
| config 2000/s | node4 | 2,000 | 225.3 | 3,276.8 | 12,320.8 | 274.6 | node-gateway 963.9, holywisp 1.8 | 1 | N |
| session c=64 | node4 | 57,665.3 | 966.7 | 3,866.6 | 9,175 | 71.5 | node-gateway 969.3, holywisp 1.8 | 1 | N |
| session 2000/s | node4 | 2,000 | 286.7 | 1,572.9 | 4,456.4 | 368.1 | node-gateway 969.3, holywisp 1.8 | 1 | N |

## S1 startup (exec → first 200 from /api/health)

| variant | config | p50 ms | p90 ms | max ms | runs |
| --- | --- | ---: | ---: | ---: | ---: |
| (a) warm | rust | 43.7 | 45.5 | 45.5 | 10 |
| (b) cold (fadvise) | rust | 43.5 | 45.5 | 45.5 | 10 |
| (c) fresh data dir | rust | 45.8 | 48.6 | 48.6 | 10 |
| (a) warm | node1 | 145.5 | 156.7 | 156.7 | 10 |
| (b) cold (fadvise) | node1 | 153.2 | 174.1 | 174.1 | 10 |

## R1 memory at rest (RSS MiB)

| variant | config | RSS |
| --- | --- | --- |
| (a) 10 s after start | rust | gnome-server 23.7, holywisp 0.6 |
| (c) after W4 N=1000 closed | rust | gnome-server 33.3, holywisp 1.3 |
| (b) after H1 (a) c=64 | rust | gnome-server 56.5, holywisp 1.8 |
| (a) 10 s after start | node1 | node-gateway 82.7, holywisp 0.6 |
| (b) after H1 (a) c=64 | node1 | node-gateway 263.2, holywisp 0.8 |
| (a) 10 s after start | node4 | node-gateway 392.7, holywisp 0.6 |
| (c) after W4 N=1000 closed | node4 | node-gateway 570.7, holywisp 2 |
| (b) after H1 (a) c=64 | node4 | node-gateway 975, holywisp 1.8 |
| (a) 10 s after start | holywisp | holywisp 0.6 |
| (c) after W4 N=1000 closed | holywisp | holywisp 1.3 |

## B1 sizes

gnome-server x86_64 glibc release: 12,876,216 B unstripped, 12,876,208 B stripped; Cargo.lock packages 234, crates in the normal tree 178.

## Notes

- rust-ctr: not run (not implemented in this pass: needs a static (musl) gnome-server from d3a's server-out target (the host glibc 2.44 binary does not run in debian:trixie) and the container runner (open))
- rust-copy: not run (not implemented in this pass: as rust-ctr, plus bench/lib/no-splice.json (Docker default seccomp minus splice; open))
- rust+caddy: not run (needs d3a's derived Caddy image (deployment/caddy/), not built yet)
- B1: x86_64 musl, aarch64 musl, panic=abort / opt-level=s variants, mimalloc and cargo bloat not measured (need d3a server-out / d1b; open)

