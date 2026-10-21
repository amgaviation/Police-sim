# Node long shift

Seed 4242, 57600 fixed steps (8.0 game hours), free patrol, officer idle at the station.
Date: 2026-10-21T18:58:08.458Z

Whole step: mean 0.746 ms, p95 1.218 ms, max 23.977 ms (wall 43.0 s).

| system | mean ms | p95 | max | share |
|---|---:|---:|---:|---:|
| physics | 0.285 | 0.431 | 12.745 | 39.6% |
| traffic | 0.255 | 0.431 | 9.827 | 35.5% |
| vehicles.pre | 0.045 | 0.091 | 9.189 | 6.2% |
| npc | 0.043 | 0.076 | 2.575 | 6.0% |
| copyPrevTransform | 0.016 | 0.027 | 8.090 | 2.2% |
| dispatch | 0.013 | 0.023 | 13.977 | 1.8% |
| vehicles.post | 0.011 | 0.019 | 8.556 | 1.6% |
| environment | 0.008 | 0.016 | 1.185 | 1.1% |
| integrateVelocity | 0.006 | 0.011 | 3.111 | 0.8% |
| scene | 0.005 | 0.019 | 7.944 | 0.7% |
| tactical | 0.004 | 0.016 | 1.770 | 0.6% |
| resources | 0.004 | 0.007 | 5.026 | 0.5% |
| force | 0.003 | 0.006 | 5.090 | 0.5% |
| backup | 0.003 | 0.005 | 8.616 | 0.4% |
| radio | 0.003 | 0.004 | 4.075 | 0.4% |
